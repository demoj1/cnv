import { expect, test } from '@playwright/test'
import { cameraState, launchApp, type Harness } from './helpers'

/** Стрелки рисуются под нодами: внутри группы клик раньше забирала сама группа. */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        { id: 'group000000001', type: 'group', label: 'Группа', x: 100, y: 100, width: 800, height: 400 },
        { id: 'left0000000001', type: 'text', text: 'слева', x: 150, y: 250, width: 160, height: 80 },
        { id: 'right000000001', type: 'text', text: 'справа', x: 650, y: 250, width: 160, height: 80 }
      ],
      edges: [
        {
          id: 'edge0000000001',
          fromNode: 'left0000000001',
          fromSide: 'right',
          toNode: 'right000000001',
          toSide: 'left'
        }
      ]
    })
  })
})
test.afterAll(async () => {
  await h.close()
})

test('клик по стрелке внутри группы выбирает стрелку, мимо неё — группу', async () => {
  const cam = await cameraState(h.page)
  const viewport = (await h.page.getByTestId('viewport').boundingBox())!
  const toScreen = (x: number, y: number): { x: number; y: number } => ({
    x: viewport.x + cam.x + x * cam.zoom,
    y: viewport.y + cam.y + y * cam.zoom
  })
  // Середина стрелки: между правым краем левой карточки и левым краем правой, на высоте 290.
  const mid = toScreen(480, 290)
  await h.page.mouse.click(mid.x, mid.y)
  await expect(h.page.locator('.edge--selected')).toHaveCount(1)
  await expect(h.page.locator('.node--selected')).toHaveCount(0)

  const empty = toScreen(480, 450)
  await h.page.mouse.click(empty.x, empty.y)
  await expect(h.page.locator('.edge--selected')).toHaveCount(0)
  await expect(h.page.locator('[data-node-id="group000000001"].node--selected')).toHaveCount(1)
})
