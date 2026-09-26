import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness

const SITES = [
  'https://example.com',
  'https://example.org',
  'https://www.iana.org',
  'https://go.dev',
  'https://nodejs.org',
  'https://www.rust-lang.org',
  'https://vitejs.dev',
  'https://www.kernel.org'
]

function canvasWith(urls: string[]): string {
  const nodes = urls.map((url, i) => ({
    id: `web${String(i).padStart(12, '0')}`,
    type: 'link',
    url,
    x: (i % 3) * 700,
    y: Math.floor(i / 3) * 520,
    width: 640,
    height: 480
  }))
  return JSON.stringify({ nodes, edges: [] })
}

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 'web.canvas'), canvasWith(SITES), 'utf8')
  await h.page.waitForSelector('[data-canvas="web.canvas"]')
  await h.page.click('[data-canvas="web.canvas"] .sidebar__open')
  await h.page.waitForTimeout(1500)
})

test.afterAll(async () => {
  await h.close()
})

const liveCount = async (): Promise<number> => h.page.locator('.node-web__body[data-live="true"]').count()

test('гости поднимаются с жёсткими настройками безопасности', async () => {
  await h.page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, {
    timeout: 20000
  })
  await h.page.waitForTimeout(6000)

  const guests = await h.app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => {
        const prefs = (
          wc as unknown as { getLastWebPreferences(): Record<string, unknown> | null }
        ).getLastWebPreferences()
        return {
          url: wc.getURL(),
          nodeIntegration: prefs?.nodeIntegration,
          contextIsolation: prefs?.contextIsolation,
          sandbox: prefs?.sandbox,
          preload: prefs?.preload ?? null,
          partition: wc.session.storagePath ?? ''
        }
      })
  )

  expect(guests.length).toBeGreaterThan(0)
  for (const g of guests) {
    expect(g.nodeIntegration, g.url).toBeFalsy()
    expect(g.contextIsolation, g.url).not.toBe(false)
    expect(g.sandbox, g.url).not.toBe(false)
    expect(g.preload, g.url).toBeNull()
    expect(g.partition, g.url).toContain('Partitions')
  }
})

test('живых гостей не больше лимита из настроек', async () => {
  const limit = await h.page.evaluate(() => window.api.settings.get().then((s) => s.web.liveLimit))
  expect(limit).toBe(6)

  const guests = await h.app.evaluate(
    ({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview').length
  )
  expect(guests).toBeLessThanOrEqual(limit)
  expect(await liveCount()).toBeLessThanOrEqual(limit)
})

test('оверлей забирает колёсико, пока нода не активна', async () => {
  const shield = h.page.locator('[data-testid="web-shield"]').first()
  await expect(shield).toBeVisible()

  const before = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return w.style.transform
  })
  const box = await shield.boundingBox()
  if (!box) throw new Error('нет оверлея')
  await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await h.page.mouse.wheel(0, 200)
  await h.page.waitForTimeout(200)

  const after = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return w.style.transform
  })
  expect(after).not.toBe(before)
})

test('двойной клик активирует ноду, Esc из гостя снимает активность', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 30 } })
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(1200)

  const node = h.page.locator('[data-node-kind="web"]').first()
  await node.dblclick({ position: { x: 100, y: 100 } })
  await h.page.waitForTimeout(400)

  const activeId = await h.page.locator('.node--active').getAttribute('data-node-id')
  expect(activeId).not.toBeNull()
  await expect(h.page.locator(`[data-node-id="${activeId}"] [data-testid="web-shield"]`)).toHaveCount(0)
  await expect(h.page.locator('[data-testid="web-shield"]')).not.toHaveCount(0)

  // Esc должен прийти именно из гостя активной ноды — через before-input-event в main.
  const guestId = await h.page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"] webview`)
    return el ? (el as unknown as { getWebContentsId(): number }).getWebContentsId() : null
  }, activeId)
  expect(guestId).not.toBeNull()

  const sent = await h.app.evaluate(({ webContents }, wcId) => {
    const target = webContents.fromId(wcId)
    if (!target) return false
    target.focus()
    target.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    target.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    return true
  }, guestId as number)
  expect(sent).toBe(true)
  await h.page.waitForTimeout(600)
  await expect(h.page.locator('.node--active')).toHaveCount(0)
})

test('ниже порога zoom живых гостей не остаётся', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 30 } })
  for (let i = 0; i < 12; i++) await h.page.keyboard.press('Control+Minus')
  await h.page.waitForTimeout(2500)

  const zoom = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return Number(/scale\(([\d.]+)\)/.exec(w.style.transform)?.[1])
  })
  expect(zoom).toBeLessThan(0.35)
  expect(await liveCount()).toBe(0)

  const guests = await h.app.evaluate(
    ({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview').length
  )
  expect(guests).toBe(0)
})

test('выгруженная нода показывает снимок того же размера', async () => {
  const sizes = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-node-kind="web"]')].map((el) => {
      const node = el as HTMLElement
      const body = node.querySelector('.node-web__body') as HTMLElement
      return {
        w: node.style.width,
        h: node.style.height,
        hasSnapshot: !!node.querySelector('.node-web__snapshot'),
        live: body.dataset.live
      }
    })
  )
  expect(sizes.length).toBe(8)
  expect(sizes.every((s) => s.live === 'false')).toBe(true)
  expect(sizes.some((s) => s.hasSnapshot)).toBe(true)
  expect(sizes.every((s) => s.w === '640px' && s.h === '480px')).toBe(true)
})

test('снимки лежат в userData, а не в .canvas', async () => {
  const raw = await fs.readFile(path.join(h.workspaceRoot, 'web.canvas'), 'utf8')
  expect(raw).not.toContain('snapshot')
  expect(raw).not.toContain('.png')

  const dir = await h.app.evaluate(({ app }) => app.getPath('userData'))
  const files = await fs.readdir(path.join(dir, 'snapshots')).catch(() => [])
  expect(files.some((f) => f.endsWith('.png'))).toBe(true)
})
