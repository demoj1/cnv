import { expect, test } from '@playwright/test'
import { cameraState, launchApp, type Harness } from './helpers'
import type { AppApi } from '@shared/api'

declare global {
  interface Window {
    api: AppApi
  }
}

let h: Harness

test.beforeAll(async () => {
  h = await launchApp()
})

test.afterAll(async () => {
  await h.close()
})

test('окно поднимается с безопасной конфигурацией', async () => {
  const prefs = await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('окно не создано')
    const wc = win.webContents
    return {
      count: BrowserWindow.getAllWindows().length,
      nodeIntegration: (
        wc as unknown as { getLastWebPreferences(): Record<string, unknown> }
      ).getLastWebPreferences()
    }
  })
  expect(prefs.count).toBe(1)
  expect(prefs.nodeIntegration.nodeIntegration).toBeFalsy()
  expect(prefs.nodeIntegration.contextIsolation).not.toBe(false)
  expect(prefs.nodeIntegration.sandbox).not.toBe(false)
  expect(prefs.nodeIntegration.webviewTag).toBe(true)
})

test('preload отдаёт только узкий api и не течёт ipcRenderer', async () => {
  const shape = await h.page.evaluate(() => ({
    hasApi: typeof window.api === 'object',
    keys: Object.keys(window.api).sort(),
    leaks: ['require', 'process', 'ipcRenderer', 'electron', 'Buffer'].filter(
      (k) => (window as unknown as Record<string, unknown>)[k] !== undefined
    )
  }))
  expect(shape.hasApi).toBe(true)
  expect(shape.keys).toContain('canvas')
  expect(shape.keys).toContain('workspace')
  expect(shape.leaks).toEqual([])
})

test('zoom колёсиком держит точку под курсором', async () => {
  const viewport = h.page.locator('[data-testid="viewport"]')
  const box = await viewport.boundingBox()
  if (!box) throw new Error('нет вьюпорта')
  const anchor = { x: box.x + 420, y: box.y + 260 }

  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(80)

  // Дробный devicePixelRatio округляет координаты на пути Playwright → Chromium,
  // поэтому якорем считаем то, что реально увидел обработчик.
  await h.page.evaluate(() => {
    const vp = document.querySelector('[data-testid="viewport"]') as HTMLElement
    ;(window as unknown as { __wheelAt: { x: number; y: number } | null }).__wheelAt = null
    vp.addEventListener(
      'wheel',
      (e) => {
        const r = vp.getBoundingClientRect()
        ;(window as unknown as { __wheelAt: { x: number; y: number } }).__wheelAt = {
          x: e.clientX - r.left,
          y: e.clientY - r.top
        }
      },
      { capture: true }
    )
  })

  const before = await cameraState(h.page)

  await h.page.mouse.move(anchor.x, anchor.y)
  for (let i = 0; i < 4; i++) {
    await h.page.keyboard.down('Control')
    await h.page.mouse.wheel(0, -120)
    await h.page.keyboard.up('Control')
    await h.page.waitForTimeout(60)
  }

  const local = await h.page.evaluate(
    () => (window as unknown as { __wheelAt: { x: number; y: number } | null }).__wheelAt
  )
  if (!local) throw new Error('обработчик колёсика не сработал')
  const worldPoint = {
    x: (local.x - before.x) / before.zoom,
    y: (local.y - before.y) / before.zoom
  }

  const after = await cameraState(h.page)
  expect(after.zoom).toBeGreaterThan(before.zoom)
  const screenNow = {
    x: worldPoint.x * after.zoom + after.x,
    y: worldPoint.y * after.zoom + after.y
  }
  expect(Math.abs(screenNow.x - local.x)).toBeLessThan(1.5)
  expect(Math.abs(screenNow.y - local.y)).toBeLessThan(1.5)
})

test('колёсико без модификатора панорамирует, Shift — по горизонтали', async () => {
  const viewport = h.page.locator('[data-testid="viewport"]')
  const box = await viewport.boundingBox()
  if (!box) throw new Error('нет вьюпорта')
  await h.page.mouse.move(box.x + 300, box.y + 300)

  const before = await cameraState(h.page)
  await h.page.mouse.wheel(0, 200)
  await h.page.waitForTimeout(80)
  const afterY = await cameraState(h.page)
  expect(afterY.y).toBeCloseTo(before.y - 200, 0)
  expect(afterY.zoom).toBeCloseTo(before.zoom, 5)

  await h.page.keyboard.down('Shift')
  await h.page.mouse.wheel(0, 150)
  await h.page.keyboard.up('Shift')
  await h.page.waitForTimeout(80)
  const afterX = await cameraState(h.page)
  expect(afterX.x).toBeCloseTo(afterY.x - 150, 0)
})

test('хоткеи масштаба', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(80)
  expect((await cameraState(h.page)).zoom).toBeCloseTo(1, 5)

  await h.page.keyboard.press('Control+Equal')
  await h.page.waitForTimeout(80)
  expect((await cameraState(h.page)).zoom).toBeGreaterThan(1)

  await h.page.keyboard.press('Control+0')
  await h.page.keyboard.press('Control+Minus')
  await h.page.waitForTimeout(80)
  expect((await cameraState(h.page)).zoom).toBeLessThan(1)
})

test('zoom ограничен сверху и снизу', async () => {
  const bounds = await h.page.evaluate(async () => {
    const viewport = document.querySelector('[data-testid="viewport"]') as HTMLElement
    const fire = (deltaY: number): void => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          ctrlKey: true,
          clientX: 200,
          clientY: 200,
          bubbles: true,
          cancelable: true
        })
      )
    }
    for (let i = 0; i < 80; i++) fire(-200)
    await new Promise((r) => requestAnimationFrame(r))
    const world = document.querySelector('[data-testid="world"]') as HTMLElement
    const max = Number(/scale\(([\d.]+)\)/.exec(world.style.transform)?.[1])
    for (let i = 0; i < 200; i++) fire(200)
    await new Promise((r) => requestAnimationFrame(r))
    const min = Number(/scale\(([\d.]+)\)/.exec(world.style.transform)?.[1])
    return { max, min }
  })
  expect(bounds.max).toBeCloseTo(4, 5)
  expect(bounds.min).toBeCloseTo(0.05, 5)
})
