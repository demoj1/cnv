import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fitAll, launchApp, type Harness } from './helpers'

let h: Harness

const canvas = JSON.stringify({
  nodes: [
    { id: 'img1', type: 'file', file: 'p.png', x: -100, y: -75, width: 200, height: 150, 'x-cnv': {} }
  ],
  edges: []
})

test.beforeAll(async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'cnv-rot-'))
  await fs.copyFile(path.resolve('tests/fixtures/pixel.png'), path.join(ws, 'p.png'))
  h = await launchApp({ workspaceDir: ws, canvasContent: canvas })
  await h.page.waitForTimeout(600)
  await fitAll(h.page)
})

test.afterAll(async () => {
  await h.close()
})

const nodeTransform = (): Promise<string | null> =>
  h.page.evaluate(() => {
    const n = document.querySelector('.node--image') as HTMLElement | null
    return n ? getComputedStyle(n).transform : null
  })

test('выделение картинки даёт гизмо и 4 угловые ручки', async () => {
  await h.page.locator('[data-node-id="img1"]').click({ position: { x: 30, y: 30 } })
  await h.page.waitForTimeout(200)
  await expect(h.page.locator('.rotate-gizmo')).toBeVisible()
  await expect(h.page.locator('.sel-handle--corner')).toHaveCount(4)
})

test('перетаскивание гизмо даёт произвольный угол', async () => {
  const before = await nodeTransform()
  const g = await h.page.locator('.rotate-gizmo').boundingBox()
  if (!g) throw new Error('нет гизмо')
  const cx = g.x + g.width / 2
  const cy = g.y + g.height / 2
  await h.page.mouse.move(cx, cy)
  await h.page.mouse.down()
  await h.page.mouse.move(cx + 80, cy + 80, { steps: 8 })
  await h.page.mouse.up()
  await h.page.waitForTimeout(200)
  expect(await nodeTransform()).not.toBe(before)
})

test('угол сохраняется в x-cnv.rotate канваса', async () => {
  await h.page.keyboard.press('Control+s')
  await h.page.waitForTimeout(800)
  const doc = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))
  const img = doc.nodes.find((n: { id: string }) => n.id === 'img1')
  expect(typeof img['x-cnv'].rotate).toBe('number')
  expect(img['x-cnv'].rotate).toBeGreaterThan(0)
})
