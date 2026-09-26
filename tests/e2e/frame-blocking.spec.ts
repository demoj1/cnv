import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { launchApp, type Harness } from './helpers'

/**
 * Проверка главного допущения архитектуры: гость `<webview>` — отдельный WebContents со
 * своим main frame, поэтому запреты на встраивание в фрейм (`X-Frame-Options`,
 * `frame-ancestors`) на него не действуют, а на `<iframe>` — действуют.
 *
 * Тест поднимает свой сервер, а не ходит в интернет: так проверяется ровно механизм,
 * а не доступность github.com и не настройки файрвола на машине.
 */

let h: Harness
let server: Server
let port = 0
/** OpenSnitch и подобные фильтры рубят исходящие у бинаря electron — тогда проверять нечего. */
let networkBlocked = false
const hits: string[] = []

const BLOCKED_BODY =
  '<!doctype html><meta charset="utf-8"><title>ЗАПРЕЩЁННАЯ СТРАНИЦА</title><h1 id="marker">FRAME-BLOCKED-PAGE</h1>'

test.beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/open') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>ОТКРЫТАЯ СТРАНИЦА</title><h1>OPEN-PAGE</h1>')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'"
    })
    res.end(BLOCKED_BODY)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')
  port = address.port

  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: 'blocked00000001',
          type: 'link',
          url: `http://127.0.0.1:${port}/blocked`,
          x: 0,
          y: 0,
          width: 640,
          height: 400
        },
        {
          id: 'open00000000001',
          type: 'link',
          url: `http://127.0.0.1:${port}/open`,
          x: 700,
          y: 0,
          width: 640,
          height: 400
        }
      ],
      edges: []
    })
  })
  await h.page.waitForTimeout(1500)

  networkBlocked = await h.app.evaluate(async ({ net }, p) => {
    try {
      const r = await net.fetch(`http://127.0.0.1:${p}/open`)
      return r.status !== 200
    } catch {
      return true
    }
  }, port)
})

test.beforeEach(() => {
  test.skip(
    networkBlocked,
    'исходящие соединения процесса electron блокирует локальный файрвол (например OpenSnitch) — разреши бинарь и перезапусти'
  )
})

test.afterAll(async () => {
  await h.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('обычная страница в webview реально грузится', async () => {
  const title = await h.app.evaluate(async ({ webContents }, p) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL().includes(`:${p}/open`))
      if (guest && !guest.isLoading()) {
        const heading = await guest.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
        if (heading) return { title: guest.getTitle(), heading }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }, port)

  expect(title).not.toBeNull()
  expect(title?.heading).toBe('OPEN-PAGE')
  expect(title?.title).toBe('ОТКРЫТАЯ СТРАНИЦА')
})

test('страница с X-Frame-Options: DENY грузится в webview', async () => {
  const result = await h.app.evaluate(async ({ webContents }, p) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL().includes(`:${p}/blocked`))
      if (guest && !guest.isLoading()) {
        const heading = await guest.executeJavaScript(
          'document.querySelector("#marker")?.textContent ?? null'
        )
        if (heading) return { title: guest.getTitle(), heading }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  }, port)

  expect(result).not.toBeNull()
  expect(result?.heading).toBe('FRAME-BLOCKED-PAGE')
  expect(result?.title).toBe('ЗАПРЕЩЁННАЯ СТРАНИЦА')
})

test('та же страница в iframe до сети не доходит', async () => {
  hits.length = 0
  const probe = await h.page.evaluate(async (p) => {
    const f = document.createElement('iframe')
    f.style.cssText = 'position:absolute;left:-9999px;width:300px;height:200px'
    f.src = `http://127.0.0.1:${p}/blocked?via=iframe`
    document.body.appendChild(f)
    await new Promise((r) => setTimeout(r, 4000))
    return { hasDocument: f.contentDocument !== null }
  }, port)

  const frames = await h.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('нет окна')
    const out: { url: string; origin: string; body: string | null }[] = []
    for (const f of win.webContents.mainFrame.frames) {
      let body: string | null = null
      try {
        body = (await f.executeJavaScript('document.body ? document.body.innerHTML : null')) as string | null
      } catch {
        body = null
      }
      out.push({ url: f.url, origin: f.origin, body })
    }
    return out
  })

  // Главное доказательство: сервер не увидел запроса от iframe вообще.
  expect(hits.filter((u) => u.includes('via=iframe'))).toEqual([])
  // Фрейм пустой и без origin, хотя url у него числится запрошенный.
  expect(frames.some((f) => (f.body ?? '').includes('FRAME-BLOCKED-PAGE'))).toBe(false)
  expect(probe.hasDocument).toBe(true)
  expect(frames.every((f) => f.origin === 'null')).toBe(true)
})
