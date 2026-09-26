const { app, BrowserWindow, session, ipcMain, webContents } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const GUEST_PARTITION = 'persist:web'

function hardenGuest(prefs, params) {
  prefs.nodeIntegration = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  delete prefs.preload
  delete prefs.preloadURL
  if (params) {
    params.nodeintegration = 'false'
    params.contextIsolation = 'true'
  }
}

function setupGuestSession() {
  const ses = session.fromPartition(GUEST_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  return ses
}

app.whenReady().then(() => {
  setupGuestSession()

  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (event, prefs, params) => {
      hardenGuest(prefs, params)
      const src = String(params.src || '')
      if (src && !/^https?:/i.test(src) && !src.startsWith('file://')) {
        event.preventDefault()
      }
    })
    wc.on('did-attach-webview', (_ev, guest) => {
      guest.setWindowOpenHandler(({ url }) => {
        wc.send('guest-window-open', { id: guest.id, url })
        return { action: 'deny' }
      })
      guest.on('before-input-event', (ev, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          ev.preventDefault()
          wc.send('guest-escape', { id: guest.id })
        }
      })
    })
  })

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.loadFile(path.join(__dirname, process.env.SPIKE_PAGE || 'index.html'))
})

ipcMain.handle('metrics', () => {
  const m = app.getAppMetrics()
  return {
    total: m.reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0),
    processes: m.map((p) => ({ type: p.type, ws: p.memory?.workingSetSize || 0 }))
  }
})

ipcMain.handle('capture', async (_e, id) => {
  const wc = webContents.fromId(id)
  if (!wc) return null
  const img = await wc.capturePage()
  return img.toDataURL()
})

ipcMain.handle('platform-info', () => ({
  ozone: process.argv.find((a) => a.startsWith('--ozone-platform')) || null,
  env: process.env.ELECTRON_OZONE_PLATFORM_HINT || null,
  wayland: !!process.env.WAYLAND_DISPLAY,
  versions: process.versions
}))

const REPORT = path.join(__dirname, 'report.json')
ipcMain.handle('report', (_e, data) => {
  let prev = {}
  try {
    prev = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
  } catch {
    prev = {}
  }
  fs.writeFileSync(REPORT, JSON.stringify({ ...prev, ...data }, null, 2))
  return true
})

app.on('window-all-closed', () => app.quit())
