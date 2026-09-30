import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

/**
 * Хоткеи должны работать на любой раскладке. На русской та же клавиша даёт кириллицу в
 * event.key, поэтому матчим по физкоду (event.code). Шлём ровно такой keydown, какой
 * рождает русская раскладка, и проверяем, что команда сработала.
 */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
})
test.afterAll(async () => {
  await h.close()
})

const dispatchKey = (opts: { code: string; key: string; ctrl?: boolean; shift?: boolean }): Promise<void> =>
  h.page.evaluate((o) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: o.code,
        key: o.key,
        ctrlKey: o.ctrl ?? false,
        shiftKey: o.shift ?? false,
        bubbles: true,
        cancelable: true
      })
    )
  }, opts)

const nodeCount = (): Promise<number> => h.page.locator('[data-node-id]').count()

test('Ctrl+T на русской раскладке (key="е") создаёт карточку', async () => {
  expect(await nodeCount()).toBe(0)
  await dispatchKey({ code: 'KeyT', key: 'е', ctrl: true })
  await expect.poll(nodeCount, { timeout: 5000 }).toBe(1)
  expect(await h.page.locator('[data-node-kind="text"]').count()).toBe(1)
})

test('Ctrl+A → выделить всё, тоже на кириллице (key="ф")', async () => {
  await dispatchKey({ code: 'KeyA', key: 'ф', ctrl: true })
  await h.page.waitForTimeout(200)
  expect(await h.page.locator('.node--selected').count()).toBe(1)
})

test('срабатывает ровно один раз (нет двойного диспатча)', async () => {
  const before = await nodeCount()
  await dispatchKey({ code: 'KeyT', key: 'е', ctrl: true })
  await h.page.waitForTimeout(400)
  expect(await nodeCount()).toBe(before + 1)
})
