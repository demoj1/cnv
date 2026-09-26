import { BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { is } from '@electron-toolkit/utils'
import { APP_NAME } from '@shared/app'

export function createMainWindow(uiScale: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    backgroundColor: '#1b1c1f',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false
    }
  })

  // На Wayland ready-to-show иногда не приходит (electron#48859) — показываем принудительно.
  const fallback = setTimeout(() => win.show(), 2500)
  win.once('ready-to-show', () => {
    clearTimeout(fallback)
    win.show()
  })

  // Масштаб интерфейса держим на zoom-факторе окна: он переживает перерисовку и
  // одинаково растягивает и холст, и диалоги. Сбрасывается при перезагрузке страницы.
  const applyScale = (): void => win.webContents.setZoomFactor(uiScale)
  applyScale()
  win.webContents.on('did-finish-load', applyScale)
  // Пинч и Ctrl+колёсико над диалогами не должны менять zoom мимо настройки.
  void win.webContents.setVisualZoomLevelLimits(1, 1)

  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/i.test(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}
