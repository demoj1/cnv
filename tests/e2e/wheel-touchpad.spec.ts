import { expect, test } from '@playwright/test'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Тачпад. Chromium присылает жесты тачпада обычными `wheel`-событиями: two-finger scroll —
 * с `deltaMode` 0 (пиксели) и `ctrlKey=false`, щипок — с `ctrlKey=true`. Здесь мы бьём
 * ровно по обработчику холста синтетическим `wheel` с этими полями: это и есть реальный
 * путь, по которому идёт тачпад (в отличие от X11-колеса мыши, у которого ctrlKey не
 * выставить). Проверяем маппинг жестов и то, что мышь в строковом режиме ведёт себя так же.
 */

let h: Harness

const canvas = JSON.stringify({
  nodes: [{ id: 'anchor0000000001', type: 'text', text: 'я', x: 0, y: 0, width: 200, height: 120 }],
  edges: []
})

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: canvas })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(300)
})

test.afterAll(async () => {
  await h?.close()
})

/** Синтетический wheel прямо в вьюпорт — попадает в наш addEventListener('wheel'). */
async function wheel(o: {
  deltaX?: number
  deltaY: number
  ctrlKey?: boolean
  shiftKey?: boolean
  deltaMode?: number
  at?: { x: number; y: number }
}): Promise<void> {
  await h.page.evaluate((o) => {
    const el = document.querySelector('[data-testid="viewport"]') as HTMLElement
    const box = el.getBoundingClientRect()
    const at = o.at ?? { x: box.width / 2, y: box.height / 2 }
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: o.deltaX ?? 0,
        deltaY: o.deltaY,
        ctrlKey: o.ctrlKey ?? false,
        shiftKey: o.shiftKey ?? false,
        deltaMode: o.deltaMode ?? 0,
        clientX: box.left + at.x,
        clientY: box.top + at.y,
        bubbles: true,
        cancelable: true
      })
    )
  }, o)
  await h.page.waitForTimeout(80)
}

const reset = async (): Promise<void> => {
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(150)
}

test('two-finger scroll панорамит холст один в один по пикселям', async () => {
  await reset()
  const before = await cameraState(h.page)
  await wheel({ deltaX: 40, deltaY: 90 }) // тачпад: пиксели, без ctrl
  const after = await cameraState(h.page)
  expect(after.zoom).toBe(before.zoom)
  expect(Math.round(after.x - before.x)).toBe(-40)
  expect(Math.round(after.y - before.y)).toBe(-90)
})

test('щипок (ctrl+wheel) зумит к точке под пальцами', async () => {
  await reset()
  const point = { x: 260, y: 200 }
  const before = await cameraState(h.page)
  const world = { x: (point.x - before.x) / before.zoom, y: (point.y - before.y) / before.zoom }

  await wheel({ deltaY: -30, ctrlKey: true, at: point })
  const after = await cameraState(h.page)
  expect(after.zoom).toBeGreaterThan(before.zoom)

  const worldAfter = { x: (point.x - after.x) / after.zoom, y: (point.y - after.y) / after.zoom }
  expect(worldAfter.x).toBeCloseTo(world.x, 1)
  expect(worldAfter.y).toBeCloseTo(world.y, 1)
})

test('щипок в обе стороны симметричен', async () => {
  await reset()
  const base = (await cameraState(h.page)).zoom
  await wheel({ deltaY: -40, ctrlKey: true })
  const zin = (await cameraState(h.page)).zoom
  expect(zin).toBeGreaterThan(base)
  await reset()
  await wheel({ deltaY: 40, ctrlKey: true })
  const zout = (await cameraState(h.page)).zoom
  expect(zout).toBeLessThan(base)
})

test('инерционный выброс дельты не телепортирует зум (потолок ×2 за тик)', async () => {
  await reset()
  const before = (await cameraState(h.page)).zoom
  await wheel({ deltaY: -5000, ctrlKey: true }) // фантомная инерция тачпада
  const after = (await cameraState(h.page)).zoom
  expect(after / before).toBeLessThanOrEqual(2.0001)
})

test('мышь в строковом режиме (deltaMode=1) панорамит соразмерно, а не на пиксель', async () => {
  await reset()
  const before = await cameraState(h.page)
  await wheel({ deltaY: 3, deltaMode: 1 }) // 3 строки
  const after = await cameraState(h.page)
  // 3 строки × 16 px — заметный шаг, а не 3 пикселя.
  expect(Math.round(before.y - after.y)).toBe(48)
})

test('Shift + вертикальное колесо мыши уходит в горизонтальную панораму', async () => {
  await reset()
  const before = await cameraState(h.page)
  await wheel({ deltaY: 100, shiftKey: true })
  const after = await cameraState(h.page)
  expect(Math.round(after.x - before.x)).toBe(-100)
  expect(Math.round(after.y - before.y)).toBe(0)
})
