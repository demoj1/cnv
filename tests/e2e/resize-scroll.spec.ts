import { expect, test, type Page } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

let h: Harness

const nodeBox = async (
  page: Page,
  id: string
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await page.locator(`[data-node-id="${id}"]`).boundingBox()
  if (!b) throw new Error('нет ноды')
  return b
}
const savedSize = async (): Promise<{ w: number; ht: number }> =>
  h.page.evaluate(() => {
    const el = document.querySelector('[data-node-id="aaaaaaaaaaaaaaaa"]') as HTMLElement
    return { w: Math.round(parseFloat(el.style.width)), ht: Math.round(parseFloat(el.style.height)) }
  })

test.beforeAll(async () => {
  const long = Array.from({ length: 50 }, (_, i) => `абзац ${i} с текстом`).join('\n\n')
  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [{ id: 'aaaaaaaaaaaaaaaa', type: 'text', text: long, x: 0, y: 0, width: 300, height: 200 }],
      edges: []
    })
  })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 760 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(300)
})
test.afterAll(async () => {
  await h.close()
})

test('за правый бок тянется только ширина', async () => {
  await h.page.locator('[data-node-id="aaaaaaaaaaaaaaaa"]').click()
  await h.page.waitForTimeout(200)
  const before = await savedSize()
  const box = await nodeBox(h.page, 'aaaaaaaaaaaaaaaa')
  // точка на правом крае, вдали от угла и середины (там точка-коннектор)
  const x = box.x + box.width,
    y = box.y + box.height * 0.78
  await h.page.mouse.move(x, y)
  await h.page.mouse.down()
  await h.page.mouse.move(x + 120, y, { steps: 8 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)
  const after = await savedSize()
  expect(after.w).toBeGreaterThan(before.w + 80)
  expect(after.ht).toBe(before.ht)
})

test('за нижний бок тянется только высота', async () => {
  const before = await savedSize()
  const box = await nodeBox(h.page, 'aaaaaaaaaaaaaaaa')
  const x = box.x + box.width * 0.3,
    y = box.y + box.height
  await h.page.mouse.move(x, y)
  await h.page.mouse.down()
  await h.page.mouse.move(x, y + 100, { steps: 8 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)
  const after = await savedSize()
  expect(after.ht).toBeGreaterThan(before.ht + 60)
  expect(after.w).toBe(before.w)
})

test('колесо над длинной карточкой скроллит её, а не двигает холст', async () => {
  // ужмём обратно, чтобы контент точно не влез
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 760 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(300)
  const box = await nodeBox(h.page, 'aaaaaaaaaaaaaaaa')
  const worldBefore = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return w.style.transform
  })
  const scrollBefore = await h.page.evaluate(
    () => (document.querySelector('[data-node-id="aaaaaaaaaaaaaaaa"] .node-text') as HTMLElement).scrollTop
  )
  await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await h.page.mouse.wheel(0, 300)
  await h.page.waitForTimeout(200)
  const scrollAfter = await h.page.evaluate(
    () => (document.querySelector('[data-node-id="aaaaaaaaaaaaaaaa"] .node-text') as HTMLElement).scrollTop
  )
  const worldAfter = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return w.style.transform
  })
  expect(scrollAfter, 'карточка прокрутилась').toBeGreaterThan(scrollBefore)
  expect(worldAfter, 'холст не сдвинулся').toBe(worldBefore)
})
