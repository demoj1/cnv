import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  win.loadFile(path.join(dir, '../renderer/index.html'))
  win.webContents.on('console-message', (e) => console.log('RENDERER:', e.message))
  setTimeout(() => app.quit(), 25000)
})
