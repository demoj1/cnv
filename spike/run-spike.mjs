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
  const app = await electron.launch({
    args: [dir],
    env: { ...process.env, ...extraEnv }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.setCamera)
  return { app, page }
}

async function waitLog(page, re, timeout = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const hit = await page.evaluate(
      (src) => window.guestLog.filter((l) => new RegExp(src).test(l.text)).at(-1) || null,
      re.source
    )
    if (hit) return hit
    await sleep(100)
  }
  return null
}

// ---------------------------------------------------------------- 1 + 2
async function spikeHitTest() {
  const { app, page } = await launch()
  const guestUrl = 'file://' + path.join(dir, 'guest.html')
  const id = await page.evaluate((u) => window.addWeb(u, 200, 150, 400, 300), guestUrl)
  await waitLog(page, /SIZE/)

  const results = []
  for (const zoom of [0.5, 1, 2]) {
    await page.evaluate((z) => window.setCamera(50, 60, z), zoom)
    await sleep(400)
    await page.evaluate(() => {
      window.guestLog.length = 0
    })
    const rect = await page.evaluate((i) => {
      const r = window.nodeRect(i)
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }, id)
    // целимся в точку, отстоящую на четверть от левого верхнего угла ноды
    const sx = rect.x + rect.w * 0.25
    const sy = rect.y + rect.h * 0.25
    await page.evaluate((i) => window.activate(i), id)
    await sleep(150)
    await page.mouse.click(sx, sy)
    const hit = await waitLog(page, /HIT/, 5000)
    const size = await page.evaluate(
      () => window.guestLog.filter((l) => /SIZE/.test(l.text)).at(-1)?.text || null
    )
    const expectedCss = { x: 400 * 0.25, y: 300 * 0.25 }
    const got = hit ? hit.text.split(' ').slice(1).map(Number) : null
    results.push({
      zoom,
      screenRect: rect,
      clickScreen: { x: Math.round(sx), y: Math.round(sy) },
      guestReported: got ? { x: got[0], y: got[1] } : null,
      expectedIfLayoutUnscaled: expectedCss,
      deltaPx: got ? { x: got[0] - expectedCss.x, y: got[1] - expectedCss.y } : null,
      guestSizeLog: size
    })
    await page.evaluate(() => window.deactivate())
  }
  log('hit-test', results)
  await app.close()
}

// ---------------------------------------------------------------- 3
async function spikeIframeBlockers() {
  const { app, page } = await launch()
  const sites = ['https://github.com', 'https://www.google.com', 'https://www.youtube.com']
  const ids = []
  for (let i = 0; i < sites.length; i++) {
    ids.push(await page.evaluate(([u, k]) => window.addWeb(u, 40 + k * 460, 40, 440, 320), [sites[i], i]))
  }
  // контрольная группа — те же сайты в iframe
  const iframeResult = await page.evaluate(async (list) => {
    const res = []
    for (const u of list) {
      const f = document.createElement('iframe')
      f.style.cssText = 'position:absolute;left:-9999px;width:300px;height:200px'
      f.src = u
      document.body.appendChild(f)
      const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), 12000)
        f.addEventListener('load', () => {
          clearTimeout(t)
          let inner = null
          try {
            inner = f.contentDocument ? f.contentDocument.body.innerHTML.length : 'null-doc'
          } catch (e) {
            inner = 'cross-origin(ok)'
          }
          resolve(`load, body=${inner}`)
        })
      })
      res.push({ url: u, iframe: ok })
      f.remove()
    }
    return res
  }, sites)

  await sleep(18000)
  const events = await page.evaluate(() => window.events)
  const webviewResult = sites.map((u, i) => {
    const mine = events.filter((e) => e.id === ids[i])
    const fin = mine.find((e) => e.ev === 'did-finish-load')
    const fail = mine.filter((e) => e.ev === 'did-fail-load' && e.code !== -3)
    return { url: u, loaded: !!fin, title: fin?.title ?? null, finalUrl: fin?.url ?? null, failures: fail }
  })
  log('iframe-blockers', { webview: webviewResult, iframeControl: iframeResult })
  await app.close()
}

// ---------------------------------------------------------------- 4
async function spikeSessionPersistence() {
  const stamp = `spike-${Date.now()}`
  {
    const { app } = await launch()
    await app.evaluate(async ({ session }, value) => {
      const ses = session.fromPartition('persist:web')
      await ses.cookies.set({
        url: 'https://example.com',
        name: 'cnv_spike',
        value,
        expirationDate: Math.floor(Date.now() / 1000) + 3600
      })
      await ses.cookies.flushStore()
    }, stamp)
    await sleep(500)
    await app.close()
  }
  await sleep(1000)
  {
    const { app } = await launch()
    const read = await app.evaluate(async ({ session }) => {
      const ses = session.fromPartition('persist:web')
      const c = await ses.cookies.get({ name: 'cnv_spike' })
      return c.map((x) => ({ name: x.name, value: x.value, domain: x.domain }))
    })
    const storagePath = await app.evaluate(({ session }) => session.fromPartition('persist:web').storagePath)
    log('session-persistence', { wrote: stamp, readBack: read, ok: read.some((c) => c.value === stamp), storagePath })
    await app.close()
  }
}

// ---------------------------------------------------------------- 5
async function spikeOverlayAndEsc() {
  const { app, page } = await launch()
  const guestUrl = 'file://' + path.join(dir, 'guest.html')
  const id = await page.evaluate((u) => window.addWeb(u, 100, 100, 500, 350), guestUrl)
  await waitLog(page, /SIZE/)
  await sleep(500)

  const rect = await page.evaluate((i) => {
    const r = window.nodeRect(i)
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, id)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2

  // колёсико над неактивной нодой должно уехать в холст, а не в гостя
  await page.evaluate(() => {
    window.guestLog.length = 0
    window.events.length = 0
  })
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, 120)
  await sleep(600)
  const inactive = await page.evaluate(() => ({
    hostWheel: window.events.filter((e) => e.ev === 'host-wheel'),
    guestWheel: window.guestLog.filter((l) => /WHEEL/.test(l.text)).length,
    cam: { ...window.cam }
  }))

  // активация двойным кликом
  await page.mouse.dblclick(cx, cy)
  await sleep(400)
  const afterActivate = await page.evaluate(() => window.activeId())

  // колёсико над активной нодой должно уйти в гостя
  await page.evaluate(() => {
    window.guestLog.length = 0
    window.events.length = 0
  })
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, 120)
  await sleep(600)
  const active = await page.evaluate(() => ({
    hostWheel: window.events.filter((e) => e.ev === 'host-wheel').length,
    guestWheel: window.guestLog.filter((l) => /WHEEL/.test(l.text)).length
  }))

  // Esc изнутри гостя через before-input-event
  const wcId = await page.evaluate((i) => window.nodes.get(i).wcId, id)
  await app.evaluate(async ({ webContents }, wid) => {
    const wc = webContents.fromId(wid)
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }, wcId)
  await sleep(600)
  const afterEsc = await page.evaluate(() => ({
    activeId: window.activeId(),
    events: window.events.filter((e) => e.ev === 'guest-escape'),
    guestGotKey: window.guestLog.filter((l) => /KEY Escape/.test(l.text)).length
  }))

  log('overlay-activation-esc', { inactive, afterActivate, active, afterEsc })
  await app.close()
}

// ---------------------------------------------------------------- 6
async function spikeSnapshot() {
  const { app, page } = await launch()
  const guestUrl = 'file://' + path.join(dir, 'guest.html')
  const id = await page.evaluate((u) => window.addWeb(u, 100, 100, 480, 320), guestUrl)
  await waitLog(page, /SIZE/)
  await sleep(800)
  const before = await page.evaluate((i) => {
    const r = window.nodeRect(i)
    return { w: r.width, h: r.height }
  }, id)
  const t0 = Date.now()
  const len = await page.evaluate((i) => window.toSnapshot(i), id)
  const captureMs = Date.now() - t0
  await sleep(300)
  const after = await page.evaluate((i) => {
    const r = window.nodeRect(i)
    return { w: r.width, h: r.height, hasImg: !!window.nodes.get(i).el.querySelector('img.snap'), hasWebview: !!window.nodes.get(i).el.querySelector('webview') }
  }, id)
  await page.evaluate(([i, u]) => window.toLive(i, u), [id, guestUrl])
  await sleep(2000)
  const relive = await page.evaluate((i) => {
    const r = window.nodeRect(i)
    return { w: r.width, h: r.height, hasImg: !!window.nodes.get(i).el.querySelector('img.snap'), hasWebview: !!window.nodes.get(i).el.querySelector('webview') }
  }, id)
  log('snapshot-swap', { before, captureMs, dataUrlBytes: len, after, relive, sizeStable: before.w === after.w && after.w === relive.w })
  await app.close()
}

// ---------------------------------------------------------------- 7
async function spikeMemory() {
  const { app, page } = await launch()
  const baseline = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0)
  )
  const steps = []
  for (let i = 0; i < 10; i++) {
    await page.evaluate((k) => window.addWeb('https://example.com', (k % 5) * 300, Math.floor(k / 5) * 250, 280, 230), i)
    await sleep(2500)
    const m = await app.evaluate(({ app: a }) => {
      const ms = a.getAppMetrics()
      return {
        total: ms.reduce((s, p) => s + (p.memory?.workingSetSize || 0), 0),
        procs: ms.length
      }
    })
    steps.push({ webviews: i + 1, rssKb: m.total, processes: m.procs })
  }
  log('memory-10-webviews', { baselineKb: baseline, steps, perWebviewKb: Math.round((steps.at(-1).rssKb - baseline) / 10) })
  await app.close()
}

// ---------------------------------------------------------------- 9
async function spikePlatform() {
  const res = {}
  for (const [name, env] of [
    ['wayland-hint-auto', {}],
    ['x11-forced', { ELECTRON_OZONE_PLATFORM_HINT: 'x11' }]
  ]) {
    try {
      const { app, page } = await launch(env)
      const info = await app.evaluate(({ app: a, screen }) => ({
        argv: process.argv.filter((x) => x.includes('ozone')),
        env: process.env.ELECTRON_OZONE_PLATFORM_HINT || null,
        waylandDisplay: !!process.env.WAYLAND_DISPLAY,
        displays: screen.getAllDisplays().map((d) => ({ scale: d.scaleFactor, size: d.size })),
        electron: process.versions.electron,
        chrome: process.versions.chrome
      }))
      const dpr = await page.evaluate(() => devicePixelRatio)
      res[name] = { ok: true, ...info, devicePixelRatio: dpr }
      await app.close()
    } catch (e) {
      res[name] = { ok: false, error: String(e).slice(0, 300) }
    }
  }
  log('platform', res)
}

const only = process.argv[2]
const all = {
  hit: spikeHitTest,
  iframe: spikeIframeBlockers,
  session: spikeSessionPersistence,
  overlay: spikeOverlayAndEsc,
  snapshot: spikeSnapshot,
  memory: spikeMemory,
  platform: spikePlatform
}
const tasks = only ? { [only]: all[only] } : all
for (const [name, fn] of Object.entries(tasks)) {
  console.log(`\n===== ${name} =====`)
  try {
    await fn()
  } catch (e) {
    log(`${name}-ERROR`, String(e).slice(0, 800))
  }
}
const file = path.join(dir, `results-${only || 'all'}.json`)
fs.writeFileSync(file, JSON.stringify(out, null, 2))
console.log(`\nwritten ${file}`)
process.exit(0)
