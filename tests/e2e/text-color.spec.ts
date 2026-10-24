import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { launchApp, type Harness } from './helpers'

/** Цвет карточки — кружками в её нижней панели, рядом со шрифтом. */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        { id: 'card0000000001', type: 'text', text: 'карточка', x: 300, y: 200, width: 260, height: 120 }
      ],
      edges: []
    })
  })
})
test.afterAll(async () => {
  await h.close()
})

test('кружок палитры красит карточку, «без цвета» снимает', async () => {
  const card = h.page.locator('[data-node-id="card0000000001"]')
  await card.click()
  await h.page.getByTestId('text-panel-toggle').click()
  await h.page.locator('[data-testid="text-colors"] [data-color="4"]').click()
  await expect(card).toHaveClass(/node--color-4/)
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  const saved = JSON.parse(await readFile(h.canvasFile, 'utf8')) as { nodes: { color?: string }[] }
  expect(saved.nodes[0]!.color).toBe('4')

  await h.page.locator('[data-testid="text-colors"] .font-panel__swatch--none').click()
  await expect(card).not.toHaveClass(/node--color-/)
  // Цвет — одна правка в истории: Ctrl+Z возвращает зелёный.
  await h.page.keyboard.press('Control+z')
  await expect(card).toHaveClass(/node--color-4/)
})
