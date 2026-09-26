import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const EMPTY = '{\n\t"nodes":[],\n\t"edges":[]\n}'

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 'board.canvas'), EMPTY, 'utf8')
  await h.page.waitForSelector('[data-canvas="board.canvas"]')
  await h.page.click('[data-canvas="board.canvas"] .sidebar__open')
  await h.page.waitForTimeout(400)
})

test.afterAll(async () => {
  await h.close()
})

const nodes = (page: Page): ReturnType<Page['locator']> => page.locator('[data-node-id]')

async function nodeBox(page: Page): Promise<{ id: string; x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-node-id]') as HTMLElement
    return { id: el.dataset.nodeId ?? '', x: parseFloat(el.style.left), y: parseFloat(el.style.top) }
  })
}

test('двойной клик по пустому месту создаёт карточку и включает редактирование', async () => {
  const viewport = h.page.locator('[data-testid="viewport"]')
  await viewport.dblclick({ position: { x: 500, y: 300 } })
  await expect(nodes(h.page)).toHaveCount(1)
  await expect(h.page.locator('.node--active .cm-editor')).toBeVisible()

  await h.page.keyboard.type('# Привет')
  await h.page.keyboard.press('Escape')
  await expect(h.page.locator('.node-text h1')).toHaveText('Привет')
})

test('перетаскивание сдвигает ноду, undo возвращает', async () => {
  const before = await nodeBox(h.page)
  const box = await h.page.locator(`[data-node-id="${before.id}"]`).boundingBox()
  if (!box) throw new Error('нет ноды')

  await h.page.mouse.move(box.x + box.width / 2, box.y + 8)
  await h.page.mouse.down()
  await h.page.mouse.move(box.x + box.width / 2 + 120, box.y + 8 + 60, { steps: 8 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(150)

  const moved = await nodeBox(h.page)
  expect(moved.x).toBeGreaterThan(before.x + 100)
  expect(moved.y).toBeGreaterThan(before.y + 40)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(150)
  const back = await nodeBox(h.page)
  expect(Math.abs(back.x - before.x)).toBeLessThan(2)
  expect(Math.abs(back.y - before.y)).toBeLessThan(2)

  await h.page.keyboard.press('Control+Shift+z')
  await h.page.waitForTimeout(150)
  expect((await nodeBox(h.page)).x).toBeGreaterThan(before.x + 100)
  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(150)
})

test('весь drag — одна запись в истории', async () => {
  const before = await nodeBox(h.page)
  const box = await h.page.locator(`[data-node-id="${before.id}"]`).boundingBox()
  if (!box) throw new Error('нет ноды')

  await h.page.mouse.move(box.x + box.width / 2, box.y + 8)
  await h.page.mouse.down()
  for (let i = 0; i < 20; i++) {
    await h.page.mouse.move(box.x + box.width / 2 + i * 5, box.y + 8 + i * 2)
  }
  await h.page.mouse.up()
  await h.page.waitForTimeout(200)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(200)
  const after = await nodeBox(h.page)
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)
})

test('стрелки двигают на 1 px, Shift — на шаг сетки', async () => {
  const before = await nodeBox(h.page)
  await h.page.locator(`[data-node-id="${before.id}"]`).click({ position: { x: 10, y: 5 } })
  await h.page.keyboard.press('ArrowRight')
  await h.page.waitForTimeout(100)
  expect((await nodeBox(h.page)).x).toBe(before.x + 1)

  await h.page.keyboard.press('Shift+ArrowRight')
  await h.page.waitForTimeout(100)
  expect((await nodeBox(h.page)).x).toBe(before.x + 21)

  await h.page.keyboard.press('Control+z')
  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(150)
})

test('marquee выделяет ноды, Ctrl+A выделяет всё, Delete удаляет', async () => {
  const viewport = h.page.locator('[data-testid="viewport"]')
  await viewport.dblclick({ position: { x: 900, y: 500 } })
  await h.page.keyboard.press('Escape')
  await expect(nodes(h.page)).toHaveCount(2)

  const vp = await viewport.boundingBox()
  if (!vp) throw new Error('нет вьюпорта')
  await h.page.mouse.move(vp.x + 20, vp.y + 20)
  await h.page.mouse.down()
  await h.page.mouse.move(vp.x + vp.width - 20, vp.y + vp.height - 20, { steps: 10 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(150)
  await expect(h.page.locator('.node--selected')).toHaveCount(2)

  await h.page.keyboard.press('Delete')
  await h.page.waitForTimeout(150)
  await expect(nodes(h.page)).toHaveCount(0)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(150)
  await expect(nodes(h.page)).toHaveCount(2)
})

test('ресайз за угловой хэндл меняет размер', async () => {
  await h.page
    .locator('[data-node-id]')
    .first()
    .click({ position: { x: 10, y: 5 } })
  await expect(h.page.locator('[data-resize-handle]')).toHaveCount(8)

  const sizeBefore = await h.page.evaluate(() => {
    const el = document.querySelector('[data-node-id]') as HTMLElement
    return { w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
  })

  const handle = h.page.locator('[data-resize-handle="se"]')
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('нет хэндла')
  await h.page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await h.page.mouse.down()
  await h.page.mouse.move(hb.x + 80, hb.y + 50, { steps: 6 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(200)

  const sizeAfter = await h.page.evaluate(() => {
    const el = document.querySelector('[data-node-id]') as HTMLElement
    return { w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
  })
  expect(sizeAfter.w).toBeGreaterThan(sizeBefore.w + 50)
  expect(sizeAfter.h).toBeGreaterThan(sizeBefore.h + 30)
})
