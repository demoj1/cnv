const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('spike', {
  metrics: () => ipcRenderer.invoke('metrics'),
  capture: (id) => ipcRenderer.invoke('capture', id),
  platformInfo: () => ipcRenderer.invoke('platform-info'),
  report: (data) => ipcRenderer.invoke('report', data),
  onGuestEscape: (cb) => ipcRenderer.on('guest-escape', (_e, p) => cb(p)),
  onGuestWindowOpen: (cb) => ipcRenderer.on('guest-window-open', (_e, p) => cb(p))
})
