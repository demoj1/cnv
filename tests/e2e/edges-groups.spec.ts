import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'слева', x: 0, y: 0, width: 200, height: 120 },
    { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'справа', x: 500, y: 0, width: 200, height: 120 },
    { id: 'cccccccccccccccc', type: 'text', text: 'внизу', x: 0, y: 400, width: 200, height: 120 }
  ],
  edges: []
})

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 'g.canvas'), canvas, 'utf8')
  await h.page.waitForSelector('[data-canvas="g.canvas"]')
  await h.page.click('[data-canvas="g.canvas"] .sidebar__open')
  await h.page.waitForTimeout(500)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(500)
})

test.afterAll(async () => {
  await h.close()
})

async function centerOf(id: string): Promise<{ x: number; y: number }> {
  const box = await h.page.locator(`[data-node-id="${id}"]`).boundingBox()
  if (!box) throw new Error(`нет ноды ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('ребро создаётся перетаскиванием от точки соединения', async () => {
  await h.page.locator('[data-node-id="aaaaaaaaaaaaaaaa"]').hover()
  await h.page.waitForSelector('[data-connect-side]')

  const dot = h.page.locator('[data-connect-side="right"]')
  const from = await dot.boundingBox()
  const to = await centerOf('bbbbbbbbbbbbbbbb')
  if (!from) throw new Error('нет точки соединения')

  await h.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await h.page.mouse.down()
  await h.page.mouse.move(to.x, to.y, { steps: 12 })
  await expect(h.page.locator('.draft-line')).toBeVisible()
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)

  await expect(h.page.locator('.edges [data-edge-id]')).toHaveCount(1)
})

test('ребро едет за нодой и попадает в файл', async () => {
  const pathBefore = await h.page.locator('.edge__line').getAttribute('d')

  const box = await h.page.locator('[data-node-id="bbbbbbbbbbbbbbbb"]').boundingBox()
  if (!box) throw new Error('нет ноды')
  await h.page.mouse.move(box.x + box.width / 2, box.y + 10)
  await h.page.mouse.down()
  await h.page.mouse.move(box.x + box.width / 2, box.y + 160, { steps: 10 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(1600)

  expect(await h.page.locator('.edge__line').getAttribute('d')).not.toBe(pathBefore)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'g.canvas'), 'utf8'))
  expect(saved.edges).toHaveLength(1)
  expect(saved.edges[0].fromNode).toBe('aaaaaaaaaaaaaaaa')
  expect(saved.edges[0].toNode).toBe('bbbbbbbbbbbbbbbb')
})

test('клик по ребру выделяет его, Delete удаляет', async () => {
  const d = await h.page.locator('.edge__line').getAttribute('d')
  const match = /C ([\d.-]+) ([\d.-]+)/.exec(d ?? '')
  expect(match).not.toBeNull()

  const point = await h.page.evaluate(() => {
    const line = document.querySelector('.edge__line') as SVGPathElement
    const at = line.getPointAtLength(line.getTotalLength() / 2)
    const rect = line.getBoundingClientRect()
    const box = line.getBBox()
    const scaleX = rect.width / (box.width || 1)
    const scaleY = rect.height / (box.height || 1)
    return { x: rect.left + (at.x - box.x) * scaleX, y: rect.top + (at.y - box.y) * scaleY }
  })

  await h.page.mouse.click(point.x, point.y)
  await h.page.waitForTimeout(300)
  await expect(h.page.locator('.edge--selected')).toHaveCount(1)
  await expect(h.page.locator('[data-edge-endpoint]')).toHaveCount(2)

  await h.page.keyboard.press('Delete')
  await h.page.waitForTimeout(1600)
  await expect(h.page.locator('.edges [data-edge-id]')).toHaveCount(0)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(400)
  await expect(h.page.locator('.edges [data-edge-id]')).toHaveCount(1)
})

test('группа создаётся по выделению и таскает вложенные ноды', async () => {
  await h.page.keyboard.press('Control+a')
  await h.page.keyboard.press('Control+g')
  await h.page.waitForTimeout(500)
  await expect(h.page.locator('[data-node-kind="group"]')).toHaveCount(1)

  const before = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-node-id]')].map((el) => ({
      id: (el as HTMLElement).dataset.nodeId,
      x: parseFloat((el as HTMLElement).style.left)
    }))
  )

  const group = h.page.locator('[data-node-kind="group"]')
  const gb = await group.boundingBox()
  if (!gb) throw new Error('нет группы')
  await h.page.mouse.move(gb.x + 30, gb.y + 10)
  await h.page.mouse.down()
  await h.page.mouse.move(gb.x + 130, gb.y + 10, { steps: 10 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(400)

  const after = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-node-id]')].map((el) => ({
      id: (el as HTMLElement).dataset.nodeId,
      x: parseFloat((el as HTMLElement).style.left)
    }))
  )

  // Сдвинулись все: и группа, и каждая вложенная нода — на одну и ту же величину.
  const deltas = after.map((a) => a.x - (before.find((b) => b.id === a.id)?.x ?? 0))
  expect(deltas.length).toBeGreaterThan(1)
  expect(new Set(deltas.map((d) => Math.round(d))).size).toBe(1)
  expect(Math.round(deltas[0] ?? 0)).not.toBe(0)

  await h.page.keyboard.press('Control+z')
  await h.page.waitForTimeout(300)
})

test('разгруппировка убирает группу и оставляет ноды', async () => {
  await h.page.locator('[data-node-kind="group"]').click({ position: { x: 20, y: 10 } })
  await h.page.keyboard.press('Control+Shift+g')
  await h.page.waitForTimeout(400)
  await expect(h.page.locator('[data-node-kind="group"]')).toHaveCount(0)
  await expect(h.page.locator('[data-node-kind="text"]')).toHaveCount(3)
})
