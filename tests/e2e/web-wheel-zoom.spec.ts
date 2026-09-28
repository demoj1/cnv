import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Ctrl+колесо над страницей должно менять масштаб ХОЛСТА, а не самой страницы.
 *
 * Сам жест распознаёт Chromium и отдаёт его событием `zoom-changed` — вот его мы и
 * поднимаем у гостя напрямую. Подставной `sendInputEvent` этого события не рождает
 * (проверено), поэтому тест проверяет НАШУ реакцию на жест, а не распознавание жеста
 * браузером. Координата курсора приходит отдельно, обычным mouseMove.
 */

let h: Harness
let server: Server
const WEB_ID = 'wheel0000000001'

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>КОЛЕСО</title><h1>WHEEL</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')

  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: WEB_ID,
          type: 'link',
          url: `http://127.0.0.1:${address.port}/p`,
          x: 0,
          y: 0,
          width: 640,
          height: 480
        }
      ],
      edges: []
    })
  })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 760 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(2500)
})

test.afterAll(async () => {
  await h?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const guestId = (): Promise<number> =>
  h.page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"] webview`)
    if (!el) throw new Error('нет гостя')
    return (el as unknown as { getWebContentsId(): number }).getWebContentsId()
  }, WEB_ID)

const wheelIntoGuest = async (wcId: number, direction: 'in' | 'out'): Promise<void> => {
  await h.app.evaluate(
    ({ webContents }, { wcId, direction }) => {
      const guest = webContents.fromId(wcId)
      if (!guest) throw new Error('гость не найден')
      guest.sendInputEvent({ type: 'mouseMove', x: 120, y: 90 } as never)
      guest.emit('zoom-changed', {}, direction)
    },
    { wcId, direction }
  )
  await h.page.waitForTimeout(400)
}

test('Ctrl+колесо над страницей увеличивает холст', async () => {
  await expect.poll(async () => h.page.locator('webview').count(), { timeout: 20000 }).toBe(1)
  const wcId = await guestId()
  const before = await cameraState(h.page)

  await wheelIntoGuest(wcId, 'in')

  const after = await cameraState(h.page)
  expect(after.zoom).toBeGreaterThan(before.zoom)
})

test('и уменьшает, а масштаб самой страницы не съезжает', async () => {
  const wcId = await guestId()
  const before = await cameraState(h.page)

  await wheelIntoGuest(wcId, 'out')

  const after = await cameraState(h.page)
  expect(after.zoom).toBeLessThan(before.zoom)

  // Страница осталась при своём: её zoom равен масштабу интерфейса.
  const uiScale = await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))
  const guestZoom = await h.app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id)
    return guest ? guest.getZoomFactor() : null
  }, wcId)
  expect(guestZoom).toBeCloseTo(uiScale, 3)
})
