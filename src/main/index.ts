import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME, CANVAS_EXT } from '@shared/app'
import { IPC } from '@shared/ipc'
import { registerFileScheme, handleFileProtocol } from './file-protocol'
import { installGuestHardening, prepareGuestSession } from './guest'
import { SettingsStore } from './settings-store'
import { Workspace } from './workspace'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { toRelative } from './paths'

app.setName(APP_NAME)
registerFileScheme()

const workspace = new Workspace()
const settings = new SettingsStore()
let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => mainWindow

interface CliTarget {
  root: string | null
  canvasRel: string | null
}

function parseCli(argv: readonly string[]): CliTarget {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  for (const arg of args) {
    const abs = path.resolve(arg)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) return { root: abs, canvasRel: null }
    if (stat.isFile() && abs.endsWith(CANVAS_EXT)) {
      const root = path.dirname(abs)
      return { root, canvasRel: toRelative(root, abs) }
    }
  }
  return { root: null, canvasRel: null }
}

const cli = parseCli(process.argv)

async function openInitialWorkspace(): Promise<void> {
  const root = cli.root ?? settings.lastWorkspace
  if (!root) return
  try {
    const info = await workspace.open(root)
    settings.noteWorkspace(info.root)
    if (cli.canvasRel) mainWindow?.webContents.send(IPC.canvasOpenRequest, cli.canvasRel)
  } catch {
    /* папка пропала — стартуем без workspace */
  }
}

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId(APP_ID)
  await settings.load()

  prepareGuestSession()
  installGuestHardening(settings)
  handleFileProtocol(workspace)
  registerIpc({ workspace, settings, getWindow })

  app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))

  mainWindow = createMainWindow()
  buildMenu(mainWindow)

  workspace.on('opened', (info) => mainWindow?.webContents.send(IPC.workspaceOpened, info))
  workspace.on('list-changed', (files) => mainWindow?.webContents.send(IPC.workspaceListChanged, files))
  workspace.on('external-change', (change) => mainWindow?.webContents.send(IPC.canvasExternalChange, change))
  settings.on('changed', (value) => mainWindow?.webContents.send(IPC.settingsChanged, value))

  mainWindow.webContents.once('did-finish-load', () => void openInitialWorkspace())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      buildMenu(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void settings.flush()
  void workspace.close()
})
