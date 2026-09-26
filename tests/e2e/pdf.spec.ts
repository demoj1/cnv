import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

test.beforeAll(async () => {
  h = await launchApp()
  await fs.copyFile(path.resolve('tests/fixtures/sample-320.pdf'), path.join(h.workspaceRoot, 'doc.pdf'))
  await fs.writeFile(
    path.join(h.workspaceRoot, 'pdf.canvas'),
    JSON.stringify({
      nodes: [{ id: 'pdf000000000001', type: 'file', file: 'doc.pdf', x: 0, y: 0, width: 560, height: 760 }],
      edges: []
    }),
    'utf8'
  )
  await h.page.waitForSelector('[data-canvas="pdf.canvas"]')
  await h.page.click('[data-canvas="pdf.canvas"] .sidebar__open')
})

test.afterAll(async () => {
  await h.close()
})

test('документ на 320 страниц открывается быстро', async () => {
  const started = Date.now()
  await h.page.waitForSelector('.node-pdf__badge', { timeout: 20000 })
  const elapsed = Date.now() - started
  await expect(h.page.locator('.node-pdf__badge')).toHaveText('1 / 320')
  expect(elapsed).toBeLessThan(10000)
})

test('неактивная нода рисует одну страницу, без текстового слоя', async () => {
  await expect(h.page.locator('.pdf-page__canvas')).toHaveCount(1)
  await expect(h.page.locator('.pdf-page__text')).toHaveCount(0)
})

test('растр становится крупнее при увеличении холста', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(1200)
  const atOne = await h.page.evaluate(
    () => (document.querySelector('.pdf-page__canvas') as HTMLCanvasElement).width
  )

  for (let i = 0; i < 4; i++) await h.page.keyboard.press('Control+Equal')
  await h.page.waitForTimeout(2000)
  const zoomed = await h.page.evaluate(
    () => (document.querySelector('.pdf-page__canvas') as HTMLCanvasElement).width
  )

  expect(zoomed).toBeGreaterThan(atOne)

  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(1200)
})

test('активная нода даёт навигацию, текстовый слой и запоминает страницу', async () => {
  await h.page.locator('[data-node-kind="pdf"]').dblclick({ position: { x: 200, y: 300 } })
  await h.page.waitForTimeout(1500)
  await expect(h.page.locator('.node-pdf__bar')).toBeVisible()
  await expect(h.page.locator('.node-pdf__total')).toHaveText('/ 320')

  await h.page.waitForSelector('.pdf-page__text span', { timeout: 20000 })
  const text = await h.page.locator('.pdf-page__text').first().innerText()
  expect(text).toContain('PAGE-1-MARKER')

  // Рендерятся только видимые страницы, а не все 320.
  const rendered = await h.page.locator('.pdf-page__canvas').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(15)

  await h.page.locator('.node-pdf__bar button[title="Следующая"]').click()
  await h.page.waitForTimeout(1500)
  await expect(h.page.locator('.node-pdf__page')).toHaveValue('2')

  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(1800)

  const sidecar = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, '.pdf.canvas.state.json'), 'utf8'))
  expect(sidecar.nodes.pdf000000000001.pdfPage).toBeGreaterThanOrEqual(2)

  const canvas = await fs.readFile(path.join(h.workspaceRoot, 'pdf.canvas'), 'utf8')
  expect(canvas).not.toContain('pdfPage')
})

test('битый PDF показывает ошибку и не роняет холст', async () => {
  await fs.writeFile(path.join(h.workspaceRoot, 'broken.pdf'), 'это не pdf', 'utf8')
  await h.page.evaluate(() => {
    const el = document.querySelector('[data-node-kind="pdf"]') as HTMLElement
    el.dataset.probe = 'was-here'
  })
  await fs.writeFile(
    path.join(h.workspaceRoot, 'pdf.canvas'),
    JSON.stringify({
      nodes: [
        { id: 'pdf000000000002', type: 'file', file: 'broken.pdf', x: 0, y: 0, width: 400, height: 500 }
      ],
      edges: []
    })
  )
  await h.page.waitForTimeout(3000)
  await expect(h.page.locator('.node-error__title')).toHaveText('PDF не открылся')
  await expect(h.page.locator('[data-testid="viewport"]')).toBeVisible()
})
