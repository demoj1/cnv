import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'a', x: 0, y: 0, width: 200, height: 100 },
    { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'b', x: 0, y: 400, width: 140, height: 160 },
    { id: 'cccccccccccccccc', type: 'text', text: 'c', x: 600, y: 200, width: 180, height: 120 }
  ],
  edges: []
})

const rects = (page: Page): Promise<Record<string, { x: number; y: number; w: number; h: number }>> =>
  page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-node-id]')].map((el) => {
        const node = el as HTMLElement
        return [
          node.dataset.nodeId ?? '',
          {
            x: parseFloat(node.style.left),
            y: parseFloat(node.style.top),
            w: parseFloat(node.style.width),
            h: parseFloat(node.style.height)
          }
        ]
      })
    )
  )

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 's.canvas'), canvas, 'utf8')
  await h.page.waitForSelector('[data-canvas="s.canvas"]')
  await h.page.click('[data-canvas="s.canvas"] .sidebar__open')
  await h.page.waitForTimeout(500)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 760 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(300)
})

test.afterAll(async () => {
  await h.close()
})

test('при перетаскивании край прилипает к краю соседа и показывает направляющую', async () => {
  const before = await rects(h.page)
  const a = before.aaaaaaaaaaaaaaaa
  const b = before.bbbbbbbbbbbbbbbb
  if (!a || !b) throw new Error('нет нод')

  const box = await h.page.locator('[data-node-id="bbbbbbbbbbbbbbbb"]').boundingBox()
  if (!box) throw new Error('нет ноды b')

  // Тащим b так, чтобы её левый край оказался в 4 px от левого края a.
  await h.page.mouse.move(box.x + 20, box.y + 10)
  await h.page.mouse.down()
  await h.page.mouse.move(box.x + 20 + 4, box.y + 10, { steps: 6 })
  await h.page.waitForTimeout(120)
  await expect(h.page.locator('.guide')).not.toHaveCount(0)
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)

  const after = await rects(h.page)
  expect(after.bbbbbbbbbbbbbbbb?.x).toBe(a.x)
  await expect(h.page.locator('.guide')).toHaveCount(0)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(300)
})

test('выравнивание по левому краю двигает все выделенные', async () => {
  await h.page.keyboard.press('Control+a')
  await h.page.waitForTimeout(150)
  // Команды выравнивания без хоткея — дёргаем через контекстное меню.
  const viewport = h.page.locator('[data-testid="viewport"]')
  const box = await viewport.boundingBox()
  if (!box) throw new Error('нет вьюпорта')
  await h.page.mouse.move(box.x + 120, box.y + 120)
  await h.page.mouse.down({ button: 'right' })
  await h.page.mouse.up({ button: 'right' })
  await h.page.waitForSelector('[data-testid="context-menu"]')
  await h.page.click('[data-command="align.left"]')
  await h.page.waitForTimeout(300)

  const after = await rects(h.page)
  const xs = Object.values(after).map((r) => r.x)
  expect(new Set(xs).size).toBe(1)
})

test('распределение делает равные зазоры', async () => {
  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(200)
  await h.page.keyboard.press('Control+a')

  const viewport = h.page.locator('[data-testid="viewport"]')
  const box = await viewport.boundingBox()
  if (!box) throw new Error('нет вьюпорта')
  await h.page.mouse.move(box.x + 120, box.y + 120)
  await h.page.mouse.down({ button: 'right' })
  await h.page.mouse.up({ button: 'right' })
  await h.page.waitForSelector('[data-testid="context-menu"]')
  await h.page.click('[data-command="align.distributeY"]')
  await h.page.waitForTimeout(300)

  const after = Object.values(await rects(h.page)).sort((p, q) => p.y - q.y)
  expect(after).toHaveLength(3)
  const gaps = after.slice(1).map((r, i) => {
    const prev = after[i]
    if (!prev) throw new Error('нет соседа')
    return Math.round(r.y - (prev.y + prev.h))
  })
  expect(new Set(gaps).size).toBe(1)
})

test('уравнять размер приводит всех к первой ноде', async () => {
  await h.page.keyboard.press('Control+a')
  const viewport = h.page.locator('[data-testid="viewport"]')
  const box = await viewport.boundingBox()
  if (!box) throw new Error('нет вьюпорта')
  await h.page.mouse.move(box.x + 120, box.y + 120)
  await h.page.mouse.down({ button: 'right' })
  await h.page.mouse.up({ button: 'right' })
  await h.page.waitForSelector('[data-testid="context-menu"]')
  await h.page.click('[data-command="align.sameSize"]')
  await h.page.waitForTimeout(300)

  const after = Object.values(await rects(h.page))
  expect(new Set(after.map((r) => `${r.w}x${r.h}`)).size).toBe(1)
})

test('привязка к сетке включается из настроек', async () => {
  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(200)
  await h.page.keyboard.press('Control+,')
  await h.page.waitForSelector('[data-testid="settings"]')
  await h.page.click('[data-setting="gridSnap"]')
  await h.page.waitForTimeout(400)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.grid.snap))).toBe(true)

  await h.page.click('[data-setting="smartGuides"]')
  await h.page.waitForTimeout(400)
  expect(await h.page.evaluate(() => window.api.settings.get().then((s) => s.snapping.smartGuides))).toBe(
    false
  )

  await h.page.click('[data-testid="settings"] .dialog__buttons button')
  await h.page.waitForTimeout(200)
  await expect(h.page.locator('[data-testid="settings"]')).toHaveCount(0)
})
