import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

const out = process.argv.find((a) => a.endsWith('.pdf')) ?? 'tests/fixtures/sample.pdf'
const pages = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 320)

const html = `<!doctype html><meta charset="utf-8"><style>
 @page { size: A4; margin: 18mm }
 body { font: 12pt/1.6 Georgia, serif }
 section { page-break-after: always }
 h1 { font-size: 20pt }
</style>` +
  Array.from({ length: pages }, (_, i) => `<section><h1>Страница ${i + 1}</h1>
   <p>The quick brown fox jumps over the lazy dog. Съешь ещё этих мягких французских булок.</p>
   <p>Маркер страницы: PAGE-${i + 1}-MARKER. Номер по порядку ${i + 1} из ${pages}.</p></section>`).join('')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const buf = await win.webContents.printToPDF({ printBackground: true })
  await fs.mkdir(path.dirname(out), { recursive: true })
  await fs.writeFile(out, buf)
  console.log(`${out}: ${pages} страниц, ${(buf.length / 1024).toFixed(0)} КБ`)
  app.quit()
})
