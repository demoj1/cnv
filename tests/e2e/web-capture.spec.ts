import { expect, test } from '@playwright/test'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * web_screenshot страницы за краем экрана: целиком, на нужной ширине, без повторов и
 * обрезки — то, что тестеры снимают для вёрстки, не трогая камеру человека.
 */

const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#8800ff']
const BLOCK = 300
const PAGE = `<!doctype html><html><body style="margin:0">${COLORS.map(
  (c, i) =>
    `<div style="height:${BLOCK}px;background:${c};font:40px sans-serif">BLOCK ${i} <span class="w"></span></div>`
).join(
  ''
)}<div style="position:absolute;top:0;right:0;width:30px;height:30px;background:#000"></div><script>for (const s of document.querySelectorAll('.w')) s.textContent = innerWidth</script></body></html>`

let h: Harness
let dir: string
let page: http.Server
let server: { url: string; token: string }

test.describe.configure({ mode: 'serial', timeout: 60_000 })

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = (await res.json()) as {
    result: { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
  }
  if (body.result.isError) throw new Error(body.result.content[0]?.text)
  return body.result.content[0] as T
}

/** Размер PNG и цвета пикселей в точках — средствами электрона. */
async function inspect(
  png: string,
  points: { x: number; y: number }[]
): Promise<{ size: { width: number; height: number }; colors: string[] }> {
  return h.app.evaluate(
    ({ nativeImage }, { png, points }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
      const size = image.getSize()
      const bitmap = image.toBitmap()
      const colors = points.map(({ x, y }) => {
        const i = (y * size.width + x) * 4
        // BGRA
        const hex = (v: number): string => (v > 200 ? 'ff' : v > 90 ? '88' : '00')
        return `#${hex(bitmap[i + 2]!)}${hex(bitmap[i + 1]!)}${hex(bitmap[i]!)}`
      })
      return { size, colors }
    },
    { png, points }
  )
}

test.beforeAll(async () => {
  page = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE))
  await new Promise<void>((r) => page.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`
  dir = await mkdtemp(path.join(tmpdir(), 'cnv-webcap-'))
  const userData = path.join(dir, 'ud')
  await mkdir(userData, { recursive: true })
  h = await launchApp({
    userDataDir: userData,
    canvasContent: JSON.stringify({
      nodes: [
        { id: 'card000000000000', type: 'text', text: 'тут камера', x: 0, y: 0, width: 200, height: 100 },
        // Далеко за краем экрана — человек её не видит.
        { id: 'web0000000000000', type: 'link', url, x: 30000, y: 30000, width: 800, height: 500 }
      ],
      edges: []
    })
  })
  server = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as typeof server
  await expect
    .poll(async () => (await tool<{ text?: string }>('web_read', { id: 'web0000000000000' })).text ?? '', {
      timeout: 30_000
    })
    .toContain('BLOCK 7')
})

test.afterAll(async () => {
  await h?.close()
  page?.close()
  await rm(dir, { recursive: true, force: true })
})

const shot = async (args: Record<string, unknown>): Promise<string> => {
  const out = await tool<{ data: string }>('web_screenshot', { id: 'web0000000000000', ...args })
  if (process.env.WEBCAP_SHOT_DIR)
    await writeFile(
      path.join(process.env.WEBCAP_SHOT_DIR, `webcap-${JSON.stringify(args).replace(/\W/g, '')}.png`),
      Buffer.from(out.data, 'base64')
    )
  return out.data
}

test('width и full: вся страница на нужной ширине, блоки по порядку, без повторов', async () => {
  for (let i = 0; i < 3; i++) {
    const png = await shot({ width: 390, full: true })
    const ys = COLORS.map((_, n) => ({ x: 10, y: n * BLOCK + BLOCK / 2 }))
    const { size, colors } = await inspect(png, ys)
    expect(size).toEqual({ width: 390, height: COLORS.length * BLOCK })
    expect(colors).toEqual(COLORS)
  }
})

test('без параметров — окно страницы как в ноде, без увеличения', async () => {
  const png = await shot({})
  const { size, colors } = await inspect(png, [
    { x: 10, y: BLOCK / 2 },
    { x: 10, y: BLOCK + BLOCK / 2 }
  ])
  // Окно страницы внутри ноды — ширина ноды без рамки.
  expect(size.width).toBeGreaterThan(780)
  expect(size.width).toBeLessThanOrEqual(800)
  expect(colors).toEqual([COLORS[0], COLORS[1]])
})

test('камеру двигают во время снимка — снимок цел, на месте ноды плашка, потом нода на месте', async () => {
  const pending = shot({ width: 390, full: true })
  await expect(h.page.locator('.node-capture-placeholder')).toHaveCount(1)
  // Человек водит холст, пока агент снимает.
  await h.page.mouse.move(600, 400)
  for (let i = 0; i < 6; i++) await h.page.mouse.wheel(0, 400)
  const { size, colors } = await inspect(
    await pending,
    COLORS.map((_, n) => ({ x: 10, y: n * BLOCK + BLOCK / 2 }))
  )
  expect(size).toEqual({ width: 390, height: COLORS.length * BLOCK })
  expect(colors).toEqual(COLORS)
  await expect(h.page.locator('.node-capture-placeholder')).toHaveCount(0)
  await expect(h.page.locator('[data-node-id="web0000000000000"]')).not.toHaveCSS('opacity', '0.01')
})

test('width шире ноды — нода на время снимка расширяется, без повторов по горизонтали', async () => {
  const node = h.page.locator('[data-node-id="web0000000000000"]')
  const before = await node.evaluate((el) => (el as HTMLElement).offsetWidth)
  // Блоки на всю ширину: повтор узкой вёрстки дал бы белые полосы справа.
  const png = await shot({ width: 1240, full: true })
  // Чёрная метка — у правого края вёрстки: при 1240 она в самом конце, а не где-то посередине.
  const { size, colors } = await inspect(png, [
    { x: 1230, y: 10 },
    { x: 780, y: 10 },
    { x: 620, y: BLOCK / 2 }
  ])
  expect(size).toEqual({ width: 1240, height: COLORS.length * BLOCK })
  expect(colors).toEqual(['#000000', COLORS[0], COLORS[0]])
  expect(await node.evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(before)
})
