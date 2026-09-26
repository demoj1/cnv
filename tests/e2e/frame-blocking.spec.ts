import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
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

const BLOCKED_BODY =
  '<!doctype html><meta charset="utf-8"><title>ЗАПРЕЩЁННАЯ СТРАНИЦА</title><h1 id="marker">FRAME-BLOCKED-PAGE</h1>'

test.beforeAll(async () => {
  server = createServer((req, res) => {
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

  h = await launchApp()
  await writeFile(
    path.join(h.workspaceRoot, 'frames.canvas'),
    JSON.stringify({
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
    }),
    'utf8'
  )
  await h.page.waitForSelector('[data-canvas="frames.canvas"]')
  await h.page.click('[data-canvas="frames.canvas"] .sidebar__open')
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

test('та же страница в iframe блокируется', async () => {
  const frameUrl = await h.page.evaluate(async (p) => {
    const f = document.createElement('iframe')
    f.style.cssText = 'position:absolute;left:-9999px;width:300px;height:200px'
    f.src = `http://127.0.0.1:${p}/blocked`
    document.body.appendChild(f)
    await new Promise((r) => setTimeout(r, 4000))
    return f.contentWindow?.location.href ?? 'нет доступа'
  }, port)

  const frames = await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('нет окна')
    return win.webContents.mainFrame.frames.map((f) => f.url)
  })

  expect(frames.some((u) => u.startsWith('chrome-error://'))).toBe(true)
  expect(frameUrl).not.toContain('/blocked')
})
