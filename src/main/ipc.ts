import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  webContents,
  type IpcMainInvokeEvent
} from 'electron'
import fs from 'node:fs/promises'
import { IPC } from '@shared/ipc'
import type { AgentNotices, DeepPartial, LinkedFile, TerminalStart, TimerTick } from '@shared/api'
import type { Settings } from '@shared/settings'
import type { Workspace } from './workspace'
import type { LinkedFiles } from './linked-files'
import type { SettingsStore } from './settings-store'
import { resolveRealInRoot } from './paths'
import { saveSnapshot, snapshotDataUrl } from './snapshots'
import {
  defaultShell,
  isAgentPaused,
  pauseTerminal,
  setAgentPaused,
  onTerminalStopped,
  resizeTerminal,
  startTerminal,
  stopTerminal,
  writeTerminal
} from './terminal'
import { readPayload, writeCanvasFragment, writeText } from './clipboard'
import { setCommandEnabled } from './menu'
import { setGuestPageZoom } from './guest'
import { noteHumanInput } from './human-typing'
import { listAgentSessions, type AgentLauncher } from './agents/launcher'
import { verifyPeer, type DeviceKeys } from './device-identity'
import type { PortalIncoming } from '@shared/portal'
import type { AgentRegistry } from './agents/registry'
import type { McpService } from './mcp'

export interface IpcContext {
  workspace: Workspace
  settings: SettingsStore
  getWindow: () => BrowserWindow | null
  openScratchpad: () => Promise<void>
  getMcp: () => McpService | null
  agents: AgentRegistry
  device: DeviceKeys
  linkedFiles: LinkedFiles
  launcher: AgentLauncher
}

export function registerIpc(ctx: IpcContext): void {
  const { workspace, settings } = ctx

  const { launcher } = ctx
  onTerminalStopped((nodeId) => launcher.stopped(nodeId))

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<R> | R
  ): void => {
    ipcMain.handle(channel, fn as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<R> | R)
  }

  handle(IPC.portalIdentity, () => ({ ...ctx.device.identity(), version: app.getVersion() }))
  handle(IPC.portalSign, (_e, data: string) => ctx.device.sign(String(data)))
  handle(IPC.portalVerify, (_e, publicKey: string, fingerprint: string, data: string, signature: string) =>
    verifyPeer(publicKey, fingerprint, data, signature)
  )
  handle(IPC.portalDeliver, async (_e, incoming: PortalIncoming) => {
    const mcp = ctx.getMcp()
    if (!mcp) return { ok: false, error: 'на этой стороне выключен MCP — агентам нечем принять письмо' }
    return mcp.deliverPortal(incoming)
  })
  handle(IPC.agentsList, () => ctx.agents.state())
  handle(IPC.agentsReload, () => ctx.agents.load())
  ipcMain.on(IPC.agentsOpenDir, () => void shell.openPath(ctx.agents.dir))
  ipcMain.on(IPC.agentsNotify, (_e, batch: AgentNotices) => ctx.getMcp()?.notify(batch))
  ipcMain.on(IPC.agentsTimerTick, (_e, tick: TimerTick) => ctx.getMcp()?.timerTick(tick))
  handle(IPC.agentsSessions, (_e, plugin: string, cwd: string | undefined) =>
    listAgentSessions(ctx.agents, plugin, cwd, settings.settings.agents.commands[plugin])
  )

  handle(IPC.workspaceCurrent, () => workspace.info)
  handle(IPC.canvasCurrent, () => settings.canvasPath)

  handle(IPC.canvasChooseFile, async () => {
    const win = ctx.getWindow()
    const options = {
      title: 'Файл канваса',
      defaultPath: settings.canvasPath ?? undefined,
      filters: [{ name: 'JSON Canvas', extensions: ['canvas'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'] as const
    }
    const result = win
      ? await dialog.showSaveDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showSaveDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || !result.filePath) return null
    const target = result.filePath.endsWith('.canvas') ? result.filePath : `${result.filePath}.canvas`
    settings.noteCanvasPath(target)
    await ctx.openScratchpad()
    return target
  })

  handle(IPC.canvasRead, (_e, relPath: string) => workspace.read(relPath))
  handle(IPC.canvasWrite, (_e, relPath: string, text: string) => workspace.write(relPath, text))

  handle(IPC.attachmentsImportPath, (_e, sourcePath: string) =>
    workspace.importPath(sourcePath, settings.settings.workspace.attachmentsDir)
  )
  handle(IPC.attachmentsRefresh, (_e, relPath: string, source: string) =>
    workspace.refreshCopy(relPath, source)
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

  ipcMain.on(IPC.filesTrack, (_e, files: LinkedFile[]) =>
    ctx.linkedFiles.track(Array.isArray(files) ? files : [])
  )
  handle(IPC.filesReadDoc, (_e, relPath: string) => ctx.linkedFiles.read(relPath))
  handle(
    IPC.filesWriteDoc,
    (_e, relPath: string, text: string, baseMtimeMs: number | null, force?: boolean) =>
      ctx.linkedFiles.write(relPath, text, baseMtimeMs, force === true)
  )

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

  handle(IPC.filesImageSize, async (_e, relPath: string) => {
    const abs = await insideRoot(relPath)
    if (!abs) return null
    const image = nativeImage.createFromPath(abs)
    return image.isEmpty() ? null : image.getSize()
  })

  handle(IPC.shellOpenExternal, async (_e, url: string) => {
    if (/^https?:$/i.test(new URL(url).protocol)) await shell.openExternal(url)
  })

  handle(IPC.clipboardWriteCanvas, (_e, fragment: string) => writeCanvasFragment(fragment))
  handle(IPC.clipboardWriteText, (_e, text: string) => writeText(text))
  handle(IPC.clipboardRead, () => readPayload())

  handle(IPC.settingsGet, () => settings.settings)
  handle(IPC.settingsPatch, (_e, patch: DeepPartial<Settings>) => settings.patch(patch))

  handle(IPC.snapshotsCapture, async (_e, guestId: number) => {
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) return null
    const image = await guest.capturePage()
    return image.isEmpty() ? null : image.toDataURL()
  })

  handle(IPC.snapshotsSave, (_e, key: string, dataUrl: string) => saveSnapshot(key, dataUrl))
  handle(IPC.snapshotsUrl, (_e, key: string) => snapshotDataUrl(key))

  handle(IPC.terminalShell, () => defaultShell())
  const starts = new Map<string, number>()
  const invalidateStart = (id: string): number => {
    const version = (starts.get(id) ?? 0) + 1
    starts.set(id, version)
    return version
  }
  handle(IPC.terminalStart, async (e, options: TerminalStart) => {
    const version = invalidateStart(options.nodeId)
    const { agent, paused, ...rest } = options
    // Агент на паузе (cnv перезапустили, пока он стоял) не запускается: его поднимет ▶.
    setAgentPaused(options.nodeId, !!agent && paused === true)
    // Старый процесс этой ноды — долой до расчёта команды: его сессия освобождается.
    stopTerminal(options.nodeId)
    const stoppedInfo = { pid: 0, shell: defaultShell(), cwd: options.cwd ?? '' }
    if (isAgentPaused(options.nodeId)) {
      launcher.stopped(options.nodeId)
      return stoppedInfo
    }
    // Агент: в шелле сразу запускается его программа — продолжение сессии или новая.
    const input = agent
      ? await launcher.commandLine({
          nodeId: options.nodeId,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.name ? { name: options.name } : {}),
          ...(options.role ? { role: options.role } : {}),
          agent
        })
      : undefined
    // Пока плагин читал сессию, человек мог нажать паузу или удалить ноду.
    if (starts.get(options.nodeId) !== version || isAgentPaused(options.nodeId)) return stoppedInfo
    const info = startTerminal(e.sender, {
      ...rest,
      shell: options.shell || settings.settings.terminal.shell || undefined,
      ...(input ? { input } : {})
    })
    return info
  })
  handle(IPC.terminalPause, (_e, nodeId: string, paused: boolean) => pauseTerminal(nodeId, paused))
  ipcMain.on(IPC.webSetPageZoom, (_e, guestId: number, zoom: number) =>
    setGuestPageZoom(guestId, zoom, settings.settings.uiScale)
  )
  // Это пишет человек: его нажатия учитываем, чтобы письма агентам не врезались в черновик.
  ipcMain.on(IPC.terminalWrite, (_e, nodeId: string, data: string) => {
    noteHumanInput(nodeId, data)
    writeTerminal(nodeId, data)
  })
  ipcMain.on(IPC.terminalResize, (_e, nodeId: string, cols: number, rows: number) =>
    resizeTerminal(nodeId, cols, rows)
  )
  ipcMain.on(IPC.terminalStop, (_e, nodeId: string) => {
    invalidateStart(nodeId)
    stopTerminal(nodeId)
    launcher.stopped(nodeId)
  })

  ipcMain.on(IPC.menuSetEnabled, (_e, state: Record<string, boolean>) => {
    setCommandEnabled(ctx.getWindow(), state)
  })
}
