import { expect, test } from '@playwright/test'
import { cameraState, launchApp, type Harness } from './helpers'

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'A', x: 0, y: 0, width: 200, height: 120 },
        { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'B', x: 2000, y: 1500, width: 200, height: 120 }
      ],
      edges: []
    })
  })
  await h.page.waitForTimeout(400)
})
test.afterAll(async () => {
  await h.close()
})

const fitAll = (): ReturnType<typeof h.page.locator> => h.page.locator('.hud__icon').nth(0)
const fitSel = (): ReturnType<typeof h.page.locator> => h.page.locator('.hud__icon').nth(1)

test('кнопки видны, вписать-выделенное выключено без выделения', async () => {
  await expect(fitAll()).toBeVisible()
  await expect(fitSel()).toBeVisible()
  await expect(fitSel()).toBeDisabled()
})

test('кнопка «вписать всё» показывает обе ноды', async () => {
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(200)
  await fitAll().click()
  await h.page.waitForTimeout(400)
  // обе ноды в кадре
  for (const id of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']) {
    const box = await h.page.locator(`[data-node-id="${id}"]`).boundingBox()
    expect(box, id).not.toBeNull()
  }
})

test('«вписать выделенное» включается и приближает к ноде', async () => {
  await h.page.locator('[data-node-id="bbbbbbbbbbbbbbbb"]').click()
  await h.page.waitForTimeout(200)
  await expect(fitSel()).toBeEnabled()
  const before = (await cameraState(h.page)).zoom
  await fitSel().click()
  await h.page.waitForTimeout(400)
  const after = (await cameraState(h.page)).zoom
  // одна небольшая нода на весь экран — зум крупнее, чем при обзоре обеих
  expect(after).toBeGreaterThan(before)
  await expect(h.page.locator('[data-node-id="bbbbbbbbbbbbbbbb"]')).toBeVisible()
})
