import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'карточка', x: 0, y: 0, width: 200, height: 100 },
    {
      id: 'wwwwwwwwwwwwwwww',
      type: 'link',
      url: 'https://example.com',
      x: 300,
      y: 0,
      width: 640,
      height: 480
    }
  ],
  edges: []
})

const metrics = (): Promise<{ innerWidth: number; dpr: number; nodeBox: number; styleWidth: string }> =>
  h.page.evaluate(() => {
    const node = document.querySelector('[data-node-id="aaaaaaaaaaaaaaaa"]') as HTMLElement
    return {
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      nodeBox: node.getBoundingClientRect().width,
      styleWidth: node.style.width
    }
  })

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: canvas })
  await h.page.waitForTimeout(800)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(400)
})

test.afterAll(async () => {
  await h.close()
})

test('масштаб интерфейса растягивает окно целиком', async () => {
  const before = await metrics()
  expect(before.styleWidth).toBe('200px')

  await h.page.evaluate(() => window.api.settings.patch({ uiScale: 2 }))
  await h.page.waitForTimeout(800)

  const after = await metrics()
  // Страница живёт в CSS-пикселях: их стало вдвое меньше, а физический размер ноды вдвое больше.
  expect(Math.abs(after.innerWidth - before.innerWidth / 2)).toBeLessThanOrEqual(2)
  expect(after.dpr / before.dpr).toBeCloseTo(2, 2)
  // В мировых координатах нода не поехала — тянется только картинка на экране.
  expect(after.styleWidth).toBe('200px')
  expect(after.nodeBox).toBeCloseTo(before.nodeBox, 0)
})

test('гостевая страница масштабируется вместе с рамкой ноды', async () => {
  await h.page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, {
    timeout: 20000
  })
  await h.page.waitForTimeout(4000)

  const parity = await h.page.evaluate(async () => {
    const el = document.querySelector('webview') as unknown as {
      executeJavaScript(code: string): Promise<unknown>
      getBoundingClientRect(): DOMRect
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const inner = (await el.executeJavaScript('innerWidth')) as number
      if (inner > 0) return { guest: inner, host: Math.round(el.getBoundingClientRect().width) }
      await new Promise((r) => setTimeout(r, 300))
    }
    return null
  })

  expect(parity).not.toBeNull()
  // Гость — отдельный WebContents; без своего zoom он показал бы вдвое больше содержимого.
  expect(Math.abs((parity?.guest ?? 0) - (parity?.host ?? 0))).toBeLessThanOrEqual(2)
})

test('масштаб меняется хоткеями и упирается в границы шкалы', async () => {
  await h.page.evaluate(() => window.api.settings.patch({ uiScale: 2 }))
  await h.page.waitForTimeout(600)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))).toBe(2)

  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
  await h.page.keyboard.press('Control+Shift+Minus')
  await h.page.waitForTimeout(600)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))).toBe(1.75)

  await h.page.keyboard.press('Control+Shift+Equal')
  await h.page.waitForTimeout(600)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))).toBe(2)

  // На верхней границе шкалы дальше не растёт.
  await h.page.keyboard.press('Control+Shift+Equal')
  await h.page.waitForTimeout(600)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))).toBe(2)
})

test('выбор масштаба из настроек работает', async () => {
  await h.page.keyboard.press('Control+,')
  await h.page.waitForSelector('[data-testid="settings"]')
  await h.page.selectOption('[data-setting="uiScale"]', '1.25')
  await h.page.waitForTimeout(800)

  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.uiScale))).toBe(1.25)
  const dpr = await h.page.evaluate(() => window.devicePixelRatio)
  await h.page.selectOption('[data-setting="uiScale"]', '1')
  await h.page.waitForTimeout(800)
  expect(await h.page.evaluate(() => window.devicePixelRatio)).toBeLessThan(dpr)
  await h.page.click('[data-testid="settings"] .dialog__buttons button')
})
