import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

/** Панель создания слева: клик — нода в центре экрана, перетаскивание — туда, где отпустил. */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
})
test.afterAll(async () => {
  await h.close()
})

const nodeCount = (): Promise<number> => h.page.locator('[data-node-id]').count()

/** Тянем иконку мышью по шагам — как человек, а не телепортом. */
async function dragFromBar(kind: string, to: { x: number; y: number }): Promise<void> {
  const box = await h.page.locator(`.create-bar__item[data-kind="${kind}"]`).boundingBox()
  if (!box) throw new Error(`нет кнопки ${kind}`)
  await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await h.page.mouse.down()
  await h.page.mouse.move(to.x, to.y, { steps: 12 })
  await expect(h.page.getByTestId('create-ghost')).toBeVisible()
  await h.page.mouse.up()
}

test('карточка встаёт центром туда, где её отпустили', async () => {
  await dragFromBar('text', { x: 500, y: 300 })
  await expect.poll(nodeCount).toBe(1)
  await expect(h.page.getByTestId('create-ghost')).toHaveCount(0)
  const box = await h.page.locator('[data-node-kind="text"]').boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.x + box!.width / 2 - 500)).toBeLessThan(3)
  expect(Math.abs(box!.y + box!.height / 2 - 300)).toBeLessThan(3)
  await h.page.keyboard.press('Escape')
})

test('отпустил над самой панелью — ничего не создаётся', async () => {
  const bar = await h.page.getByTestId('create-bar').boundingBox()
  const box = await h.page.locator('.create-bar__item[data-kind="text"]').boundingBox()
  await h.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await h.page.mouse.down()
  await h.page.mouse.move(bar!.x + bar!.width / 2, bar!.y + bar!.height - 4, { steps: 8 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)
  expect(await nodeCount()).toBe(1)
})

test('агент, вытащенный при выделенной карточке, связан с ней стрелкой', async () => {
  await h.page.locator('[data-node-kind="text"]').click()
  await expect(h.page.locator('.node--selected')).toHaveCount(1)
  await dragFromBar('agent', { x: 1000, y: 400 })
  await expect.poll(nodeCount).toBe(2)
  await expect(h.page.locator('[data-edge-id]')).toHaveCount(1)
  // Новая нода выделена — ровно она одна.
  await expect(h.page.locator('.node--selected')).toHaveCount(1)
})

test('клик без перетаскивания — терминал в центре экрана', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 600, y: 700 } })
  await h.page.locator('.create-bar__item[data-kind="terminal"]').click()
  await expect.poll(nodeCount).toBe(3)
  // Ничего не было выделено — стрелок не прибавилось.
  await expect(h.page.locator('[data-edge-id]')).toHaveCount(1)
})
