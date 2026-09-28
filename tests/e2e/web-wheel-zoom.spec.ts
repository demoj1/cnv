import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Ctrl+колесо над активной страницей меняет масштаб ХОЛСТА, а не страницы, и тянет его
 * к точке под курсором.
 *
 * Механика: клавиша уходит гостю, main видит её в `before-input-event` и говорит холсту
 * поднять щит. Пока щит поднят, колесо достаётся обычному обработчику холста — с
 * настоящей дельтой и настоящим курсором. Выпрашивать то и другое у гостя бесполезно:
 * в `input-event` колесо приходит без дельты и без координат (проверено).
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
  await expect.poll(() => h.page.locator('webview').count(), { timeout: 20000 }).toBe(1)
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

/** Клавиша уходит именно в гостя — так же, как от живой мыши и клавиатуры. */
const ctrlInGuest = async (wcId: number, down: boolean): Promise<void> => {
  await h.app.evaluate(
    ({ webContents }, { wcId, down }) => {
      const guest = webContents.fromId(wcId)
      if (!guest) throw new Error('гость не найден')
      guest.focus()
      guest.sendInputEvent({
        type: down ? 'keyDown' : 'keyUp',
        keyCode: 'Control',
        modifiers: down ? ['control'] : []
      } as Parameters<typeof guest.sendInputEvent>[0])
    },
    { wcId, down }
  )
  await h.page.waitForTimeout(300)
}

const shields = (): Promise<number> => h.page.locator('[data-testid="web-shield"]').count()

test('активная нода отдаёт мышь странице, а с зажатым Ctrl забирает обратно', async () => {
  await h.page.locator('[data-node-kind="web"]').dblclick({ position: { x: 200, y: 150 } })
  await expect.poll(shields, { timeout: 10000 }).toBe(0)

  const wcId = await guestId()
  await ctrlInGuest(wcId, true)
  await expect.poll(shields, { timeout: 10000 }).toBe(1)

  await ctrlInGuest(wcId, false)
  await expect.poll(shields, { timeout: 10000 }).toBe(0)
})

test('колесо с зажатым Ctrl зумит холст в точку под курсором', async () => {
  const wcId = await guestId()
  // Живая клавиша видна обоим: фокусному гостю — событием, холсту — модификатором в
  // событиях мыши. Воспроизводим ровно это.
  await h.page.keyboard.down('Control')
  await ctrlInGuest(wcId, true)
  await expect.poll(shields, { timeout: 10000 }).toBe(1)

  const before = await cameraState(h.page)
  // Точка под курсором: заметно в стороне от центра окна, иначе разницы не видно.
  const point = { x: 260, y: 200 }
  const worldBefore = {
    x: (point.x - before.x) / before.zoom,
    y: (point.y - before.y) / before.zoom
  }

  await h.page.mouse.move(point.x, point.y)
  await h.page.mouse.wheel(0, -300)
  await h.page.waitForTimeout(400)

  const after = await cameraState(h.page)
  expect(after.zoom).toBeGreaterThan(before.zoom)

  // Мир под курсором остался тем же — значит тянули именно к курсору, а не к центру.
  const worldAfter = { x: (point.x - after.x) / after.zoom, y: (point.y - after.y) / after.zoom }
  expect(worldAfter.x).toBeCloseTo(worldBefore.x, 0)
  expect(worldAfter.y).toBeCloseTo(worldBefore.y, 0)

  // Масштаб самой страницы не тронут: им распоряжается только UI-скейл.
  const uiScale = await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))
  const guestZoom = await h.app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? null,
    wcId
  )
  expect(guestZoom).toBeCloseTo(uiScale, 3)

  await ctrlInGuest(wcId, false)
  await h.page.keyboard.up('Control')
})

test('щит не залипает: движение мыши без Ctrl возвращает страницу', async () => {
  const wcId = await guestId()
  await ctrlInGuest(wcId, true)
  await expect.poll(shields, { timeout: 10000 }).toBe(1)

  // Клавишу отпустили так, что гость этого не увидел (фокус уехал, окно потеряло его и
  // так далее). Первое же событие без Ctrl обязано вернуть мышь странице.
  await h.page.mouse.move(300, 240)
  await expect.poll(shields, { timeout: 10000 }).toBe(0)
})
