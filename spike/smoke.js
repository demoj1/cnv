const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 400, height: 300 })
  await w.loadURL('data:text/html,<h1>ok</h1>')
  console.log('SMOKE_OK', process.versions.electron, process.versions.chrome, 'ozone-arg', process.argv.filter(a=>a.includes('ozone')).join(','))
  app.quit()
})
