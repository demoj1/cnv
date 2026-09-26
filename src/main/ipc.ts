import { BrowserWindow, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import { IPC } from '@shared/ipc'
import type { DeepPartial } from '@shared/api'
import type { Settings } from '@shared/settings'
import type { Workspace } from './workspace'
import type { SettingsStore } from './settings-store'
import { resolveRealInRoot } from './paths'
import { saveSnapshot, snapshotDataUrl } from './snapshots'
import { setCommandEnabled } from './menu'

export interface IpcContext {
  workspace: Workspace
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
}

export function registerIpc(ctx: IpcContext): void {
  const { workspace, settings } = ctx

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<R> | R
  ): void => {
    ipcMain.handle(channel, fn as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<R> | R)
  }

  handle(IPC.workspaceCurrent, () => workspace.info)
  handle(IPC.workspaceRecent, () => settings.recentWorkspaces)
  handle(IPC.workspaceList, () => (workspace.rootPath ? workspace.list() : []))

  handle(IPC.workspaceChoose, async () => {
    const win = ctx.getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    const info = await workspace.open(picked)
    settings.noteWorkspace(info.root)
    return info
  })

  handle(IPC.workspaceOpen, async (_e, root: string) => {
    const info = await workspace.open(root)
    settings.noteWorkspace(info.root)
    return info
  })

  handle(IPC.canvasRead, (_e, relPath: string) => workspace.read(relPath))
  handle(IPC.canvasWrite, (_e, relPath: string, text: string) => workspace.write(relPath, text))
  handle(IPC.canvasCreate, (_e, relPath: string) => workspace.create(relPath))
  handle(IPC.canvasRename, (_e, from: string, to: string) => workspace.rename(from, to))
  handle(IPC.canvasRemove, (_e, relPath: string) => workspace.remove(relPath))

  handle(IPC.attachmentsImportPath, (_e, sourcePath: string) =>
    workspace.importPath(sourcePath, settings.settings.workspace.attachmentsDir)
  )
  handle(IPC.attachmentsImportBytes, (_e, fileName: string, bytes: ArrayBuffer) =>
    workspace.importBytes(fileName, new Uint8Array(bytes), settings.settings.workspace.attachmentsDir)
  )

  const insideRoot = async (relPath: string): Promise<string | null> => {
    const root = workspace.rootPath
    return root ? resolveRealInRoot(root, relPath) : null
  }

  handle(IPC.filesStat, async (_e, relPath: string) => {
    const abs = await insideRoot(relPath)
    if (!abs) return null
    try {
      const st = await fs.stat(abs)
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  })

  handle(IPC.filesReadText, async (_e, relPath: string) => {
    const abs = await insideRoot(relPath)
    if (!abs) return null
    try {
      return await fs.readFile(abs, 'utf8')
    } catch {
      return null
    }
  })

  handle(IPC.filesOpenInSystem, async (_e, relPath: string) => {
    const abs = await insideRoot(relPath)
    if (abs) await shell.openPath(abs)
  })

  handle(IPC.filesChoose, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = ctx.getWindow()
    const options = { properties: ['openFile', 'multiSelections'] as const, filters }
    const result = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    return result.canceled ? [] : result.filePaths
  })

  handle(IPC.filesPreview, async (_e, relPath: string, maxSide: number) => {
    const abs = await insideRoot(relPath)
    if (!abs) return null
    try {
      const image = nativeImage.createFromPath(abs)
      if (image.isEmpty()) return null
      const { width, height } = image.getSize()
      const scale = Math.min(1, maxSide / Math.max(width, height))
      const resized = scale < 1 ? image.resize({ width: Math.round(width * scale), quality: 'good' }) : image
      return resized.toDataURL()
    } catch {
      return null
    }
  })

  handle(IPC.shellOpenExternal, async (_e, url: string) => {
    if (/^https?:$/i.test(new URL(url).protocol)) await shell.openExternal(url)
  })

  handle(IPC.settingsGet, () => settings.settings)
  handle(IPC.settingsPatch, (_e, patch: DeepPartial<Settings>) => settings.patch(patch))

  handle(IPC.snapshotsSave, (_e, key: string, dataUrl: string) => saveSnapshot(key, dataUrl))
  handle(IPC.snapshotsUrl, (_e, key: string) => snapshotDataUrl(key))

  ipcMain.on(IPC.menuSetEnabled, (_e, state: Record<string, boolean>) => {
    setCommandEnabled(ctx.getWindow(), state)
  })
}
