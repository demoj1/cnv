import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const out = {}
const log = (k, v) => {
  out[k] = v
  console.log(`## ${k}\n${JSON.stringify(v, null, 2)}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch(args = []) {
  const app = await electron.launch({ args: [dir, ...args] })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.setCamera)
  return { app, page }
}

function xClients() {
  try {
    return execSync('xlsclients -l 2>/dev/null | grep -i -A2 "Window\\|Command" | head -40', {
      encoding: 'utf8'
    })
  } catch {
    return '(xlsclients недоступен)'
  }
}

// Реальная проверка ozone: нативный Wayland-клиент НЕ виден в xlsclients.
async function ozone() {
  const res = {}
  for (const [name, args] of [
    ['default (no flags)', []],
    ['--ozone-platform=x11', ['--ozone-platform=x11']],
    ['--ozone-platform=wayland', ['--ozone-platform=wayland']]
  ]) {
    try {
      const { app, page } = await launch(args)
      await page.evaluate(() => (document.title = 'CNV_OZONE_PROBE'))
      await sleep(1500)
      const clients = xClients()
      const seenInX11 = /cnv|electron|CNV_OZONE_PROBE/i.test(clients)
      const pid = await app.evaluate(() => process.pid)
      const xPids = (() => {
        try {
          return execSync('xlsclients -l 2>/dev/null | grep -c "Window" || true', { encoding: 'utf8' }).trim()
        } catch {
          return '?'
        }
      })()
      res[name] = { launched: true, pid, seenInX11, xClientCount: xPids }
      await app.close()
      await sleep(500)
    } catch (e) {
      res[name] = { launched: false, error: String(e).slice(0, 400) }
    }
  }
  res.baselineXClients = (() => {
    try {
      return execSync('xlsclients -l 2>/dev/null | grep -c "Window" || true', { encoding: 'utf8' }).trim()
    } catch {
      return '?'
    }
  })()
  log('ozone-platform', res)
}

// Процессная модель: сколько OS-процессов реально порождают N гостей разных origin.
async function processModel() {
  const { app, page } = await launch()
  const urls = [
    'https://example.com',
    'https://example.org',
    'https://www.wikipedia.org',
    'https://go.dev',
    'https://nodejs.org'
  ]
  for (const u of urls) {
    await page.evaluate((x) => window.addWeb(x, Math.random() * 400, Math.random() * 300, 260, 200), u)
    await sleep(3000)
  }
  const info = await app.evaluate(({ webContents, app: a }) => {
    const wcs = webContents.getAllWebContents().map((wc) => ({
      type: wc.getType(),
      url: wc.getURL().slice(0, 60),
      osPid: wc.getOSProcessId()
    }))
    return {
      webContents: wcs,
      distinctGuestPids: [...new Set(wcs.filter((w) => w.type === 'webview').map((w) => w.osPid))],
      metrics: a.getAppMetrics().map((p) => ({ type: p.type, pid: p.pid, wsMb: Math.round((p.memory?.workingSetSize || 0) / 1024) }))
    }
  })
  log('process-model', info)
  await app.close()
}

// Чёткость текста при zoom: сравниваем резкость (дисперсию градиента) без и с will-change.
async function willChange() {
  const { app, page } = await launch()
  await page.evaluate(() => {
    window.addCard('Sharpness probe — The quick brown fox 0123456789 Ёжик в тумане', 40, 40, 460, 120)
  })
  await sleep(500)
  const shots = {}
  for (const z of [1, 2]) {
    await page.evaluate((zz) => window.setCamera(10, 10, zz), z)
    await sleep(80)
    shots[`z${z}-during`] = path.join(dir, `wc-z${z}-during.png`)
    await page.screenshot({ path: shots[`z${z}-during`], clip: { x: 0, y: 0, width: 900, height: 320 } })
    await sleep(1200)
    shots[`z${z}-settled`] = path.join(dir, `wc-z${z}-settled.png`)
    await page.screenshot({ path: shots[`z${z}-settled`], clip: { x: 0, y: 0, width: 900, height: 320 } })
  }
  const wcAfter = await page.evaluate(() => getComputedStyle(document.getElementById('world')).willChange)
  log('will-change', { shots, willChangeAfterSettle: wcAfter })
  await app.close()
}

const only = process.argv[2]
const all = { ozone, processModel, willChange }
for (const [name, fn] of Object.entries(only ? { [only]: all[only] } : all)) {
  console.log(`\n===== ${name} =====`)
  try {
    await fn()
  } catch (e) {
    log(`${name}-ERROR`, String(e).slice(0, 800))
  }
}
fs.writeFileSync(path.join(dir, `results3-${only || 'all'}.json`), JSON.stringify(out, null, 2))
process.exit(0)
