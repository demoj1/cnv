import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'карточка', x: 0, y: 0, width: 220, height: 120 },
    { id: 'iiiiiiiiiiiiiiii', type: 'file', file: 'pixel.png', x: 320, y: 0, width: 300, height: 200 }
  ],
  edges: []
})

const saved = async (): Promise<{
  nodes: { id: string; color?: string; width: number; height: number }[]
}> => JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))

test.beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cnv-polish-'))
  await fs.copyFile(path.resolve('tests/fixtures/pixel.png'), path.join(dir, 'pixel.png'))
  h = await launchApp({ workspaceDir: dir, canvasContent: canvas })
  await h.page.waitForTimeout(800)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(300)
})

test.afterAll(async () => {
  await h.close()
})

async function runCommand(command: string): Promise<void> {
  const box = await h.page.locator('[data-node-id="aaaaaaaaaaaaaaaa"]').boundingBox()
  if (!box) throw new Error('нет ноды')
  await h.page.mouse.move(box.x + 20, box.y + 10)
  await h.page.mouse.down({ button: 'right' })
  await h.page.mouse.up({ button: 'right' })
  await h.page.waitForSelector('[data-testid="context-menu"]')
  await h.page.click(`[data-command="${command}"]`)
  await h.page.waitForTimeout(1600)
}

test('цвет выбирается из контекстного меню и попадает в файл', async () => {
  await runCommand('color.4')
  const doc = await saved()
  expect(doc.nodes.find((n) => n.id === 'aaaaaaaaaaaaaaaa')?.color).toBe('4')
  await expect(h.page.locator('[data-node-id="aaaaaaaaaaaaaaaa"]')).toHaveClass(/node--color-4/)

  await runCommand('color.none')
  const cleared = await saved()
  expect(cleared.nodes.find((n) => n.id === 'aaaaaaaaaaaaaaaa')?.color).toBeUndefined()
})

test('картинка сбрасывается к исходному размеру', async () => {
  await h.page.locator('[data-node-id="iiiiiiiiiiiiiiii"]').click({ position: { x: 20, y: 10 } })
  const box = await h.page.locator('[data-node-id="iiiiiiiiiiiiiiii"]').boundingBox()
  if (!box) throw new Error('нет картинки')
  await h.page.mouse.move(box.x + 20, box.y + 10)
  await h.page.mouse.down({ button: 'right' })
  await h.page.mouse.up({ button: 'right' })
  await h.page.waitForSelector('[data-testid="context-menu"]')
  await h.page.click('[data-command="edit.resetSize"]')
  await h.page.waitForTimeout(1600)

  const doc = await saved()
  const image = doc.nodes.find((n) => n.id === 'iiiiiiiiiiiiiiii')
  expect(image?.width).toBe(64)
  expect(image?.height).toBe(48)
})

test('авто-высота подгоняет карточку под содержимое', async () => {
  await h.page.evaluate(() => window.api.settings.patch({ nodes: { textAutoHeight: true } }))
  await h.page.locator('[data-node-id="aaaaaaaaaaaaaaaa"]').dblclick({ position: { x: 40, y: 20 } })
  await h.page.waitForSelector('.cm-editor')
  // Абзацы, а не мягкие переносы: markdown склеил бы одиночные переводы строки в один абзац.
  for (let i = 0; i < 10; i++) {
    await h.page.keyboard.type(`абзац ${i}`)
    await h.page.keyboard.press('Enter')
    await h.page.keyboard.press('Enter')
  }
  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(2500)

  const doc = await saved()
  const card = doc.nodes.find((n) => n.id === 'aaaaaaaaaaaaaaaa')
  expect(card?.height).toBeGreaterThan(200)
})

test('справка по хоткеям открывается по F1', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('F1')
  await h.page.waitForSelector('[data-testid="shortcuts"]')
  await expect(h.page.locator('[data-testid="shortcuts"] kbd').first()).toBeVisible()
  await h.page.click('[data-testid="shortcuts"] .dialog__buttons button')
  await expect(h.page.locator('[data-testid="shortcuts"]')).toHaveCount(0)
})

test('тема переключается из настроек', async () => {
  await h.page.keyboard.press('Control+,')
  await h.page.waitForSelector('[data-testid="settings"]')
  await h.page.selectOption('[data-setting="theme"]', 'dark')
  await h.page.waitForTimeout(500)
  expect(await h.page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  await h.page.selectOption('[data-setting="theme"]', 'light')
  await h.page.waitForTimeout(500)
  expect(await h.page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await h.page.click('[data-testid="settings"] .dialog__buttons button')
})

test('переводы строк в карточке сохраняются', async () => {
  await h.page.locator('[data-testid="viewport"]').dblclick({ position: { x: 700, y: 500 } })
  await h.page.waitForSelector('.cm-editor')
  await h.page.keyboard.type('первая строка')
  await h.page.keyboard.press('Enter')
  await h.page.keyboard.type('вторая строка')
  await h.page.keyboard.press('Enter')
  await h.page.keyboard.type('третья строка')
  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(600)

  const card = h.page.locator('.node-text').last()
  await expect(card.locator('br')).toHaveCount(2)
  const shown = await card.innerText()
  expect(shown.split('\n').filter(Boolean)).toEqual(['первая строка', 'вторая строка', 'третья строка'])
})
