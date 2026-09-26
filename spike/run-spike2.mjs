import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const out = {}
const log = (k, v) => {
  out[k] = v
  console.log(`## ${k}\n${JSON.stringify(v, null, 2)}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch(extraEnv = {}) {
  const app = await electron.launch({ args: [dir], env: { ...process.env, ...extraEnv } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.setCamera)
  return { app, page }
}

const ORIGINS = [
  'https://example.com',
  'https://example.org',
  'https://www.wikipedia.org',
  'https://www.rust-lang.org',
  'https://go.dev',
  'https://nodejs.org',
  'https://vitejs.dev',
  'https://www.kernel.org',
  'https://httpbin.org/html',
  'https://www.iana.org'
]

// Память: 10 РАЗНЫХ origin, иначе Chromium склеивает их в один renderer-процесс.
async function memoryDistinct() {
  const { app, page } = await launch()
  const snap = () =>
    app.evaluate(({ app: a }) => {
      const ms = a.getAppMetrics()
      return {
        totalKb: ms.reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0),
        procs: ms.length,
        byType: ms.reduce((acc, p) => {
          acc[p.type] = (acc[p.type] || 0) + 1
          return acc
        }, {})
      }
    })

  const baseline = await snap()
  const steps = []
  for (let i = 0; i < ORIGINS.length; i++) {
    await page.evaluate(
      ([u, k]) => window.addWeb(u, (k % 5) * 300, Math.floor(k / 5) * 250, 280, 230),
      [ORIGINS[i], i]
    )
    await sleep(3500)
    steps.push({ n: i + 1, url: ORIGINS[i], ...(await snap()) })
  }
  const last = steps.at(-1)
  log('memory-distinct-origins', {
    baseline,
    steps,
    deltaMb: Math.round((last.totalKb - baseline.totalKb) / 1024),
    perWebviewMb: Math.round((last.totalKb - baseline.totalKb) / 1024 / ORIGINS.length)
  })
  await app.close()
}

// Контроль iframe: смотрим не contentDocument (он всегда null для cross-origin),
// а реальный URL дочернего фрейма в webContents — заблокированный XFO уходит в
// chrome-error:// или остаётся about:blank.
async function iframeControl() {
  const { app, page } = await launch()
  const sites = ['https://github.com', 'https://www.google.com', 'https://www.youtube.com']
  await page.evaluate((list) => {
    list.forEach((u, i) => {
      const f = document.createElement('iframe')
      f.id = `f${i}`
      f.style.cssText = `position:absolute;left:${i * 320}px;top:600px;width:300px;height:200px`
      f.src = u
      document.body.appendChild(f)
    })
  }, sites)
  await sleep(15000)
  const frames = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents
    return wc.mainFrame.frames.map((f) => ({ url: f.url, origin: f.origin, name: f.name }))
  })
  const pwFrames = page.frames().map((f) => ({ url: f.url() }))
  log('iframe-control', { childFrames: frames, playwrightFrames: pwFrames })
  await app.close()
}

// Чёткость: скриншоты холста на разных zoom + отчёт did-fail-load только по main frame.
async function crisp() {
  const { app, page } = await launch()
  const guestUrl = 'file://' + path.join(dir, 'guest.html')
  await page.evaluate(
    (u) => {
      window.addCard(
        '# Заголовок\nThe quick brown fox jumps over the lazy dog 0123456789\nПроверка чёткости кириллицы.',
        60,
        60,
        420,
        140
      )
      window.addWeb(u, 60, 230, 420, 300)
    },
    guestUrl
  )
  await sleep(2500)
  const shots = {}
  for (const z of [0.5, 1, 2]) {
    await page.evaluate((zz) => window.setCamera(20, 20, zz), z)
    await sleep(900)
    const p = path.join(dir, `crisp-${String(z).replace('.', '_')}.png`)
    await page.screenshot({ path: p, clip: { x: 0, y: 0, width: 1000, height: 700 } })
    shots[z] = p
  }
  log('crispness-shots', shots)
  await app.close()
}

const only = process.argv[2]
const all = { memory2: memoryDistinct, iframe2: iframeControl, crisp }
for (const [name, fn] of Object.entries(only ? { [only]: all[only] } : all)) {
  console.log(`\n===== ${name} =====`)
  try {
    await fn()
  } catch (e) {
    log(`${name}-ERROR`, String(e).slice(0, 800))
  }
}
fs.writeFileSync(path.join(dir, `results2-${only || 'all'}.json`), JSON.stringify(out, null, 2))
process.exit(0)
