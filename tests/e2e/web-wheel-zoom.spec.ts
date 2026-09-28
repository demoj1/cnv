import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Веб-нода живёт в двух режимах, и переключаются они явно: двойной клик отдаёт мышь
 * странице, `Esc` возвращает её холсту. Пока мышь у холста, колесо и `Ctrl`+колесо
 * работают как на любой другой части холста — тем же кодом, без исключений для гостя.
 *
 * Ввод тут настоящий, через `xdotool`: синтетическое колесо Playwright идёт мимо
 * реального пути и уже один раз позволило мне объявить рабочим то, что не работало.
 */

let h: Harness
let server: Server

const xdotoolReady = (): boolean => {
  if (!process.env.DISPLAY) return false
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const xdo = (...args: string[]): void => {
  execFileSync('xdotool', args, { env: process.env })
}

test.skip(!xdotoolReady(), 'нужен X-дисплей и xdotool: запускать под xvfb-run')

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>КОЛЕСО</title>' +
        '<style>body{margin:0;height:5000px;background:#eef}</style><h1>WHEEL</h1>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')

  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: 'wheel0000000001',
          type: 'link',
          url: `http://127.0.0.1:${address.port}/p`,
          x: 0,
          y: 0,
          width: 900,
          height: 600
        }
      ],
      edges: []
    })
  })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 760 } })
  await h.page.keyboard.press('Control+0')
  await expect.poll(() => h.page.locator('webview').count(), { timeout: 20000 }).toBe(1)

  const winId = execFileSync('xdotool', ['search', '--name', 'cnv'], { env: process.env })
    .toString()
    .trim()
    .split('\n')
    .pop()
  xdo('windowraise', String(winId))
  xdo('windowfocus', '--sync', String(winId))
  xdo('mousemove', '--sync', '400', '300')
})

test.afterAll(async () => {
  await h?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const shields = (): Promise<number> => h.page.locator('[data-testid="web-shield"]').count()
const guestZoom = (): Promise<number | null> =>
  h.app.evaluate(({ webContents }) => {
    const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    return guest ? guest.getZoomFactor() : null
  })
const guestScroll = (): Promise<number | null> =>
  h.page.evaluate(() => {
    const el = document.querySelector('webview')
    if (!el) return null
    return (el as unknown as { getWebContentsId(): number }).getWebContentsId()
  })

/** Ctrl+колесо настоящим вводом: клавиша зажимается и отпускается на уровне X11. */
async function ctrlWheel(direction: 'in' | 'out', ticks = 1): Promise<void> {
  xdo('keydown', 'ctrl')
  for (let i = 0; i < ticks; i++) xdo('click', direction === 'in' ? '4' : '5')
  await h.page.waitForTimeout(250)
  xdo('keyup', 'ctrl')
  await h.page.waitForTimeout(150)
}

test('пока мышь у холста, Ctrl+колесо над страницей зумит холст', async () => {
  expect(await shields()).toBe(1)

  // Где курсор на самом деле, спрашиваем у страницы: xdotool двигает его в координатах
  // экрана, а камера считает во вьюпорте, и окно лежит со смещением.
  await h.page.evaluate(() => {
    const store = window as unknown as { __at?: { x: number; y: number } }
    window.addEventListener('pointermove', (e) => {
      store.__at = { x: e.clientX, y: e.clientY }
    })
  })
  xdo('mousemove', '--sync', '401', '301')
  xdo('mousemove', '--sync', '400', '300')
  await h.page.waitForTimeout(200)
  const point = await h.page.evaluate(() => (window as unknown as { __at?: { x: number; y: number } }).__at)
  if (!point) throw new Error('страница не увидела курсор')

  const before = await cameraState(h.page)
  const worldBefore = { x: (point.x - before.x) / before.zoom, y: (point.y - before.y) / before.zoom }

  await ctrlWheel('in')

  const after = await cameraState(h.page)
  expect(after.zoom).toBeGreaterThan(before.zoom)

  // Точка мира под курсором не сдвинулась — тянули к курсору, а не к центру.
  const worldAfter = { x: (point.x - after.x) / after.zoom, y: (point.y - after.y) / after.zoom }
  expect(worldAfter.x).toBeCloseTo(worldBefore.x, 0)
  expect(worldAfter.y).toBeCloseTo(worldBefore.y, 0)

  // Масштабом страницы распоряжается только UI-скейл.
  const uiScale = await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))
  expect(await guestZoom()).toBeCloseTo(uiScale, 3)
})

test('десять жестов подряд — все десять срабатывают', async () => {
  const misses: string[] = []
  for (let i = 0; i < 10; i++) {
    const direction = i % 2 === 0 ? 'in' : 'out'
    const before = (await cameraState(h.page)).zoom
    await ctrlWheel(direction)
    const after = (await cameraState(h.page)).zoom
    if (after === before) misses.push(`${i} (${direction}) остался на ${before.toFixed(3)}`)
  }
  expect(misses, 'жест обязан срабатывать каждый раз, а не через раз').toEqual([])
})

test('двойной клик отдаёт мышь странице, Esc возвращает холсту', async () => {
  await h.page.locator('[data-node-kind="web"]').dblclick({ position: { x: 300, y: 250 } })
  await expect.poll(shields, { timeout: 10000 }).toBe(0)
  expect(await guestScroll()).not.toBeNull()

  // В режиме страницы холст колесо не трогает.
  const before = await cameraState(h.page)
  xdo('click', '5')
  await h.page.waitForTimeout(300)
  expect((await cameraState(h.page)).zoom).toBe(before.zoom)

  // Esc возвращает мышь холсту, и жест снова работает.
  const wcId = await h.page.evaluate(() => {
    const el = document.querySelector('webview')
    return (el as unknown as { getWebContentsId(): number }).getWebContentsId()
  })
  await h.app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    guest?.focus()
    guest?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' } as never)
    guest?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' } as never)
  }, wcId)
  await expect.poll(shields, { timeout: 10000 }).toBe(1)

  const back = await cameraState(h.page)
  await ctrlWheel('in')
  expect((await cameraState(h.page)).zoom).toBeGreaterThan(back.zoom)
})
