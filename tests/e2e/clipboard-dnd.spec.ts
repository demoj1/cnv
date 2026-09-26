import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'первая', x: 0, y: 0, width: 200, height: 100 },
    { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'вторая', x: 300, y: 0, width: 200, height: 100 }
  ],
  edges: [
    { id: 'eeeeeeeeeeeeeeee', fromNode: 'aaaaaaaaaaaaaaaa', toNode: 'bbbbbbbbbbbbbbbb', toSide: 'left' }
  ]
})

/** Считаем по документу, а не по DOM: ноды вне видимой области не рендерятся (culling). */
const nodeCount = (): Promise<number> =>
  h.page.evaluate(() => document.querySelectorAll('[data-node-id]').length)

const savedNodes = async (): Promise<
  { id: string; type: string; text?: string; file?: string; url?: string }[]
> => {
  const raw = await fs.readFile(path.join(h.workspaceRoot, 'c.canvas'), 'utf8')
  return JSON.parse(raw).nodes
}

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 'c.canvas'), canvas, 'utf8')
  await h.page.waitForSelector('[data-canvas="c.canvas"]')
  await h.page.click('[data-canvas="c.canvas"] .sidebar__open')
  await h.page.waitForTimeout(500)
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
})

test.afterAll(async () => {
  await h.close()
})

test('копирование и вставка переносят ноды вместе с рёбрами', async () => {
  await h.page.keyboard.press('Control+a')
  await h.page.keyboard.press('Control+c')
  await h.page.waitForTimeout(400)

  const clip = await h.app.evaluate(({ clipboard }) => clipboard.readText())
  expect(clip).toContain('"nodes"')
  expect(clip).toContain('первая')

  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 700, y: 500 } })
  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(1600)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'c.canvas'), 'utf8'))
  expect(saved.nodes).toHaveLength(4)
  expect(saved.edges).toHaveLength(2)
  const ids = new Set(saved.nodes.map((n: { id: string }) => n.id))
  expect(ids.size).toBe(4)
  for (const e of saved.edges) {
    expect(ids.has(e.fromNode)).toBe(true)
    expect(ids.has(e.toNode)).toBe(true)
  }
})

test('вырезание убирает ноды, вставка возвращает', async () => {
  await h.page.keyboard.press('Control+a')
  await h.page.keyboard.press('Control+x')
  await h.page.waitForTimeout(1600)
  expect(await nodeCount()).toBe(0)
  expect(await savedNodes()).toHaveLength(0)

  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(1600)
  expect(await savedNodes()).toHaveLength(4)
})

test('вставка ссылки из буфера даёт веб-ноду', async () => {
  await h.app.evaluate(({ clipboard }) => clipboard.writeText('https://example.com/from-clipboard'))
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 900, y: 600 } })
  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(1600)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'c.canvas'), 'utf8'))
  const link = saved.nodes.find((n: { type: string }) => n.type === 'link')
  expect(link?.url).toBe('https://example.com/from-clipboard')
})

test('вставка обычного текста даёт карточку', async () => {
  await h.app.evaluate(({ clipboard }) => clipboard.writeText('просто заметка из буфера'))
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 300, y: 650 } })
  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(1600)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'c.canvas'), 'utf8'))
  expect(saved.nodes.some((n: { text?: string }) => n.text === 'просто заметка из буфера')).toBe(true)
})

test('вставка внутри редактора текста не создаёт ноду', async () => {
  const before = await nodeCount()
  await h.page
    .locator('[data-node-kind="text"]')
    .first()
    .dblclick({ position: { x: 40, y: 20 } })
  await h.page.waitForSelector('.cm-editor')
  await h.app.evaluate(({ clipboard }) => clipboard.writeText('внутрь редактора'))
  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(600)
  expect(await nodeCount()).toBe(before)
  await h.page.keyboard.press('Escape')
})

test('картинка из буфера сохраняется во вложения', async () => {
  const png = await fs.readFile(path.resolve('tests/fixtures/pixel.png'))
  await h.app.evaluate(
    async ({ clipboard, ClipboardItem }, bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    },
    [...png]
  )

  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 500, y: 700 } })
  await h.page.keyboard.press('Control+v')
  await h.page.waitForTimeout(1800)

  const attachments = await fs.readdir(path.join(h.workspaceRoot, 'attachments')).catch(() => [])
  expect(attachments.some((f) => f.endsWith('.png'))).toBe(true)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'c.canvas'), 'utf8'))
  expect(saved.nodes.some((n: { file?: string }) => n.file?.startsWith('attachments/'))).toBe(true)
})
