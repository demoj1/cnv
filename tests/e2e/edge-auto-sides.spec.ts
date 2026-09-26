import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { launchApp, type Harness } from './helpers'

let h: Harness

// Ровно случай владельца: две карточки, связь слева направо — потом меняем их местами.
const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'левая', x: 0, y: 0, width: 200, height: 120 },
    { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'правая', x: 600, y: 0, width: 200, height: 120 }
  ],
  edges: [
    {
      id: 'eeeeeeeeeeeeeeee',
      fromNode: 'aaaaaaaaaaaaaaaa',
      fromSide: 'right',
      toNode: 'bbbbbbbbbbbbbbbb',
      toSide: 'left'
    }
  ]
})

/** Крайние точки кривой в мировых координатах. */
const edgeEnds = (): Promise<{ from: number; to: number }> =>
  h.page.evaluate(() => {
    const d = (document.querySelector('.edge__line') as SVGPathElement).getAttribute('d') ?? ''
    const m = /^M ([\d.-]+) [\d.-]+ C .* ([\d.-]+) [\d.-]+$/.exec(d)
    if (!m) throw new Error(`не разобрал путь: ${d}`)
    return { from: Number(m[1]), to: Number(m[2]) }
  })

const savedEdge = async (): Promise<{ fromSide?: string; toSide?: string }> =>
  JSON.parse(await fs.readFile(h.canvasFile, 'utf8')).edges[0]

/** Перетаскиваем ноду мышью — так владелец и меняет карточки местами. */
async function dragNode(id: string, dx: number): Promise<void> {
  const box = await h.page.locator(`[data-node-id="${id}"]`).boundingBox()
  if (!box) throw new Error(`нет ноды ${id}`)
  await h.page.mouse.move(box.x + box.width / 2, box.y + 12)
  await h.page.mouse.down()
  await h.page.mouse.move(box.x + box.width / 2 + dx, box.y + 12, { steps: 12 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(300)
}

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: canvas })
  await h.page.waitForTimeout(700)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(400)
})

test.afterAll(async () => {
  await h.close()
})

test('связь идёт из правого края левой ноды в левый край правой', async () => {
  const ends = await edgeEnds()
  expect(ends.from).toBeLessThan(ends.to)
})

test('поменяли ноды местами — стороны развернулись сами', async () => {
  const before = await edgeEnds()
  // Утаскиваем левую ноду далеко вправо, за правую.
  await dragNode('aaaaaaaaaaaaaaaa', 900)

  await expect.poll(async () => (await edgeEnds()).from, { timeout: 15000 }).not.toBe(before.from)
  const ends = await edgeEnds()
  // Связь снова идёт навстречу: начало правее конца, а не огибает обе ноды.
  expect(ends.from).toBeGreaterThan(ends.to)

  // В файл уезжают те же стороны, что на экране, — иначе в Obsidian связь уйдёт не туда.
  await expect.poll(async () => (await savedEdge()).fromSide, { timeout: 15000 }).toBe('left')
  expect((await savedEdge()).toSide).toBe('right')
})

test('выключенный автоподбор оставляет стороны как записано', async () => {
  await h.page.evaluate(() => window.api.settings.patch({ edges: { autoSides: false } }))
  await h.page.waitForTimeout(500)

  const before = await edgeEnds()
  await dragNode('aaaaaaaaaaaaaaaa', -900)
  await expect.poll(async () => (await edgeEnds()).from, { timeout: 15000 }).not.toBe(before.from)

  // Ноды вернулись на места, но стороны остались теми, что записаны в файле.
  expect(await savedEdge()).toMatchObject({ fromSide: 'left', toSide: 'right' })

  await h.page.evaluate(() => window.api.settings.patch({ edges: { autoSides: true } }))
  await expect.poll(async () => (await savedEdge()).fromSide, { timeout: 15000 }).toBe('right')
  expect((await savedEdge()).toSide).toBe('left')
})

test('связь без записанных сторон получает их при первом же сохранении', async () => {
  const fresh = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        { id: 'cccccccccccccccc', type: 'text', text: 'c', x: 0, y: 0, width: 200, height: 120 },
        { id: 'dddddddddddddddd', type: 'text', text: 'd', x: 0, y: 500, width: 200, height: 120 }
      ],
      edges: [{ id: 'ffffffffffffffff', fromNode: 'cccccccccccccccc', toNode: 'dddddddddddddddd' }]
    })
  })
  try {
    await expect
      .poll(async () => JSON.parse(await fs.readFile(fresh.canvasFile, 'utf8')).edges[0].fromSide, {
        timeout: 15000
      })
      .toBe('bottom')
    const edge = JSON.parse(await fs.readFile(fresh.canvasFile, 'utf8')).edges[0]
    expect(edge.toSide).toBe('top')
  } finally {
    await fresh.close()
  }
})
