import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { launchApp, type Harness } from './helpers'

/**
 * Главная жалоба владельца: страницы выгружались, стоило увести их за экран, и при
 * возвращении грузились заново — то есть теряли и прокрутку, и вход, и введённое.
 *
 * Судим по счётчику запросов на своём сервере, а не по событиям гостя: событие может
 * соврать, лишний GET — нет. Ходим на 127.0.0.1, чтобы проверять механизм, а не
 * доступность интернета.
 */

let h: Harness
let server: Server
let port = 0
/** Сколько раз запросили каждую страницу: лишний GET — это и есть перезагрузка. */
const hits = new Map<string, number>()
const hitsOn = (path: string): number => hits.get(path) ?? 0

const WEB_ID = 'web000000000001'

const canvasWith = (path: string): string =>
  JSON.stringify({
    nodes: [
      {
        id: WEB_ID,
        type: 'link',
        url: `http://127.0.0.1:${port}${path}`,
        x: 0,
        y: 0,
        width: 640,
        height: 480
      },
      { id: 'text00000000001', type: 'text', text: 'якорь', x: 0, y: 6000, width: 200, height: 120 }
    ],
    edges: []
  })

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? ''
    hits.set(path, hitsOn(path) + 1)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (path === '/nav') {
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ПЕРВАЯ</title><h1>FIRST</h1>' +
          '<script>setTimeout(() => { location.href = "/nav2" }, 600)</script>'
      )
      return
    }
    res.end('<!doctype html><meta charset="utf-8"><title>СТРАНИЦА</title><h1>PERSIST-PAGE</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('сервер не поднялся')
  port = address.port

  h = await launchApp({ canvasContent: canvasWith('/keep') })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(2500)
})

test.afterAll(async () => {
  await h?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const liveIn = (t: Harness): Promise<number> => t.page.locator('.node-web__body[data-live="true"]').count()
const liveCount = (): Promise<number> => liveIn(h)
const guestCount = (t: Harness = h): Promise<number> =>
  t.app.evaluate(
    ({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview').length
  )

/** Уводим холст так, чтобы веб-нода точно ушла за край экрана. */
async function panAway(t: Harness, dy: number): Promise<void> {
  await t.page.mouse.move(400, 400)
  for (let i = 0; i < 6; i++) await t.page.mouse.wheel(0, dy / 6)
  await t.page.waitForTimeout(300)
}

const offscreenIn = (t: Harness): Promise<boolean> =>
  t.page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`)
    if (!el) return true
    const r = el.getBoundingClientRect()
    return r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth
  }, WEB_ID)
const offscreen = (): Promise<boolean> => offscreenIn(h)

test('по умолчанию ни лимита живых, ни порогов выгрузки', async () => {
  const web = await h.page.evaluate(() => window.api.settings.get().then((s) => s.web))
  expect(web.liveLimit).toBe(0)
  expect(web.lodZoomThreshold).toBe(0)
  expect(web.offscreenUnloadMs).toBe(0)
})

test('страница загрузилась ровно один раз', async () => {
  await expect.poll(() => liveCount(), { timeout: 20000 }).toBe(1)
  test.skip(hitsOn('/keep') === 0, 'исходящие у electron зарублены файрволом — проверять нечего')
  expect(hitsOn('/keep')).toBe(1)
})

test('ушла за экран — остаётся живой и не перезагружается', async () => {
  await panAway(h, 4000)
  expect(await offscreen()).toBe(true)

  // Четыре такта жизненного цикла (TICK_MS = 1000) — старых 20 с уже не ждём.
  await h.page.waitForTimeout(4500)

  expect(await h.page.locator(`[data-node-id="${WEB_ID}"]`).count()).toBe(1)
  expect(await liveCount()).toBe(1)
  expect(await guestCount()).toBe(1)
  expect(hitsOn('/keep')).toBe(1)
})

test('обзор всего холста её тоже не убивает', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
  for (let i = 0; i < 12; i++) await h.page.keyboard.press('Control+Minus')
  await h.page.waitForTimeout(4500)

  const zoom = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return Number(/scale\(([\d.]+)\)/.exec(w.style.transform)?.[1])
  })
  expect(zoom).toBeLessThan(0.35)
  expect(await liveCount()).toBe(1)
  // Живая нода не уходит в упрощённый вид: упрощение — это тот же демонтаж гостя.
  expect(await h.page.locator(`[data-node-id="${WEB_ID}"] .node-lod`).count()).toBe(0)
  expect(hitsOn('/keep')).toBe(1)
})

test('порог в настройках снова включает выгрузку', async () => {
  // Свой инстанс: у этого теста своя камера, чужие zoom и pan тут всё ломают.
  const t = await launchApp({ canvasContent: canvasWith('/unload') })
  try {
    await t.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
    await t.page.keyboard.press('Control+0')
    await expect.poll(() => liveIn(t), { timeout: 20000 }).toBe(1)
    expect(hitsOn('/unload')).toBe(1)

    await t.page.evaluate(() => window.api.settings.patch({ web: { offscreenUnloadMs: 2000 } }))
    await panAway(t, 4200)
    expect(await offscreenIn(t)).toBe(true)
    await expect.poll(() => liveIn(t), { timeout: 15000 }).toBe(0)
    await expect.poll(() => guestCount(t), { timeout: 15000 }).toBe(0)

    // Вернулись — и вот тут страница обязана загрузиться заново, второй раз.
    await panAway(t, -4200)
    await expect.poll(() => liveIn(t), { timeout: 15000 }).toBe(1)
    await expect.poll(() => hitsOn('/unload'), { timeout: 15000 }).toBe(2)
  } finally {
    await t.close()
  }
})

test('переход внутри страницы не пересоздаёт гостя', async () => {
  const t = await launchApp({ canvasContent: canvasWith('/nav') })
  try {
    await expect.poll(() => liveIn(t), { timeout: 20000 }).toBe(1)
    const guestId = (): Promise<number | null> =>
      t.page.evaluate((id) => {
        const el = document.querySelector(`[data-node-id="${id}"] webview`)
        return el ? (el as unknown as { getWebContentsId(): number }).getWebContentsId() : null
      }, WEB_ID)

    await expect.poll(guestId, { timeout: 20000 }).not.toBeNull()
    const before = await guestId()

    // Страница сама уходит на /nav2; адрес в документе обновляется мимо истории холста.
    await expect.poll(() => hitsOn('/nav2'), { timeout: 20000 }).toBe(1)
    await t.page.waitForTimeout(2000)

    // Тот же гость: иначе улетели бы сессия страницы и история «назад».
    expect(await guestId()).toBe(before)
    // И ровно один заход на каждый адрес — никаких повторных загрузок.
    expect(hitsOn('/nav')).toBe(1)
    expect(hitsOn('/nav2')).toBe(1)
    expect(await guestCount(t)).toBe(1)
  } finally {
    await t.close()
  }
})
