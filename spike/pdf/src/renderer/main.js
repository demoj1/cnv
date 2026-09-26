import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
console.log('WORKER_URL ' + workerUrl)

const pdfUrl = new URL('./sample-320.pdf', import.meta.url).href

async function run() {
  const t0 = performance.now()
  const doc = await pdfjs.getDocument({ url: pdfUrl, isEvalSupported: false }).promise
  console.log(`OPEN pages=${doc.numPages} ms=${(performance.now() - t0).toFixed(0)}`)

  const page = await doc.getPage(7)
  const text = await page.getTextContent()
  const joined = text.items.map((i) => i.str).join(' ')
  console.log(`TEXT7 ${joined.includes('PAGE-7-MARKER') ? 'marker-ok' : 'marker-MISSING'} len=${joined.length}`)

  const canvas = document.getElementById('c')
  for (const scale of [0.5, 1, 2, 3]) {
    const t = performance.now()
    const viewport = page.getViewport({ scale })
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise
    console.log(`RENDER scale=${scale} ${canvas.width}x${canvas.height} ms=${(performance.now() - t).toFixed(0)}`)
  }

  const t1 = performance.now()
  const last = await doc.getPage(320)
  const vp = last.getViewport({ scale: 1 })
  console.log(`LASTPAGE 320 ${Math.round(vp.width)}x${Math.round(vp.height)} ms=${(performance.now() - t1).toFixed(0)}`)
  console.log('DONE')
}

run().catch((e) => console.log('ERROR ' + e))
