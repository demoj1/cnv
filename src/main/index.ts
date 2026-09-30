import { BrowserWindow, app } from 'electron'
import path from 'node:path'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APP_ID, APP_NAME, CANVAS_EXT, EMPTY_CANVAS_TEXT } from '@shared/app'
import { IPC } from '@shared/ipc'
import { registerFileScheme, handleFileProtocol } from './file-protocol'
import { applyGuestScale, installGuestHardening, prepareGuestSession } from './guest'
import { SettingsStore } from './settings-store'
import { Workspace } from './workspace'
import { createMainWindow } from './window'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'

app.setName(APP_NAME)
registerFileScheme()

const workspace = new Workspace()
const settings = new SettingsStore()
let mainWindow: BrowserWindow | null = null
let flushed = false
const getWindow = (): BrowserWindow | null => mainWindow

/** Приложение — скретчпад: всегда ровно один канвас в одном файле. */
function canvasFromCli(argv: readonly string[]): string | null {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'))
  for (const arg of args) {
    const abs = path.resolve(arg)
    if (!abs.endsWith(CANVAS_EXT)) continue
    try {
      if (fsSync.statSync(abs).isFile()) return abs
    } catch {
      // Несуществующий путь с правильным расширением — создадим его.
      return abs
    }
  }
  return null
}

function defaultCanvasPath(): string {
  const documents = (() => {
    try {
      return app.getPath('documents')
    } catch {
      return app.getPath('home')
    }
  })()
  return path.join(documents, APP_NAME, `scratchpad${CANVAS_EXT}`)
}

async function openScratchpad(): Promise<void> {
  const target = canvasFromCli(process.argv) ?? settings.canvasPath ?? defaultCanvasPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.access(target)
  } catch {
    await fs.writeFile(target, EMPTY_CANVAS_TEXT, 'utf8')
  }
  const info = await workspace.open(path.dirname(target))
  settings.noteCanvasPath(target)
  mainWindow?.webContents.send(IPC.workspaceOpened, info)
  mainWindow?.webContents.send(IPC.canvasOpenRequest, path.basename(target))
}

void app.whenReady().then(async () => {
  electronApp.setAppUserModelId(APP_ID)
  await settings.load()

  prepareGuestSession(workspace)
  installGuestHardening(settings)
  handleFileProtocol(workspace)
  registerIpc({ workspace, settings, getWindow, openScratchpad })

  app.on('browser-window-created', (_e, window) => optimizer.watchWindowShortcuts(window))

  mainWindow = createMainWindow(settings.settings.uiScale)
  buildMenu(mainWindow)

  workspace.on('opened', (info) => mainWindow?.webContents.send(IPC.workspaceOpened, info))
  workspace.on('external-change', (change) => mainWindow?.webContents.send(IPC.canvasExternalChange, change))
  settings.on('changed', (value) => {
    mainWindow?.webContents.setZoomFactor(value.uiScale)
    applyGuestScale(value.uiScale)
    mainWindow?.webContents.send(IPC.settingsChanged, value)
  })

  mainWindow.webContents.once('did-finish-load', () => void openScratchpad())

  // Закрытие окна не должно терять несохранённое: ждём, пока renderer допишет файл.
  mainWindow.on('close', (event) => {
    if (flushed || !mainWindow) return
    event.preventDefault()
    const window = mainWindow
    const done = (): void => {
      flushed = true
      window.close()
    }
    const timer = setTimeout(done, 2000)
    void window.webContents
      .executeJavaScript('window.__cnvFlush ? window.__cnvFlush() : null', true)
      .then(() => {
        clearTimeout(timer)
        done()
      })
      .catch(() => {
        clearTimeout(timer)
        done()
      })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      flushed = false
      mainWindow = createMainWindow(settings.settings.uiScale)
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
