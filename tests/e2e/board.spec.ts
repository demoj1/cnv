import { expect, test, type Locator } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Канбан-доска: карточки с холста встраиваются в дорожки, между дорожками и обратно на
 * холст — мышью; у дорожки свой скролл; агент, соединённый с доской, получает письма.
 */

const FAKE = `export default {
  id: 'fake', label: 'Фейк', command: 'echo',
  start: () => 'echo READY', resume: () => 'echo READY', getSession: (q) => 'fake-' + q.nodeId
}`

const BOARD = 'board00000000000'
let h: Harness
let dir: string

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test.beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cnv-board-'))
  const userData = path.join(dir, 'ud')
  const workspace = path.join(dir, 'ws')
  await mkdir(path.join(userData, 'agents'), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(userData, 'agents', 'fake.mjs'), FAKE)
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({ settings: { terminal: { shell: '/bin/sh' } }, canvasPath: null })
  )
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: `long${i}`,
    text: `Длинная ${i}\n\nстрока\n\nещё`
  }))
  await writeFile(
    path.join(workspace, 'scratchpad.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: BOARD,
          type: 'text',
          text: '## Спринт',
          x: 0,
          y: 0,
          width: 900,
          height: 520,
          'x-cnv': {
            board: {
              title: 'Спринт',
              lanes: [
                { id: 'todo', title: 'Backlog', cards: [{ id: 'c1', text: 'Первая' }] },
                { id: 'doing', title: 'In progress', cards: [] },
                { id: 'done', title: 'Done', cards: many }
              ]
            }
          }
        },
        { id: 'card000000000000', type: 'text', text: 'С холста', x: 0, y: 600, width: 200, height: 80 },
        {
          id: 'agent00000000000',
          type: 'text',
          text: '`агент`',
          x: 1000,
          y: 0,
          width: 500,
          height: 300,
          'x-cnv': { terminal: { name: 'Агент', agent: { plugin: 'fake', sessionId: '' } } }
        }
      ],
      edges: [{ id: 'edge000000000000', fromNode: 'agent00000000000', toNode: BOARD }]
    })
  )
  h = await launchApp({ userDataDir: userData, workspaceDir: workspace })
  await expect(h.page.getByTestId('board')).toBeVisible()
})

test.afterAll(async () => {
  await h?.close()
  await rm(dir, { recursive: true, force: true })
})

const lane = (title: string): Locator => h.page.getByTestId('board-lane').filter({ hasText: title })
const cards = (title: string): Locator => lane(title).getByTestId('board-card')

async function drag(from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox()
  if (!box) throw new Error('не видно, что тащить')
  await h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await h.page.mouse.down()
  await h.page.mouse.move(to.x, to.y, { steps: 12 })
  await h.page.mouse.up()
}

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const box = await l.boundingBox()
  if (!box) throw new Error('нет цели')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const saved = async (): Promise<{
  nodes: { id: string; text?: string; 'x-cnv'?: { board?: unknown } }[]
}> => {
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  return JSON.parse(await readFile(h.canvasFile, 'utf8'))
}

test('карточка с холста встраивается в дорожку, нода уходит с холста', async () => {
  const node = h.page.locator('[data-node-id="card000000000000"]')
  await drag(node, await center(lane('In progress')))
  await expect(node).toHaveCount(0)
  await expect(cards('In progress')).toHaveText([/^С холста\s*$/])
})

test('карточка — в другую дорожку перетаскиванием', async () => {
  // Верхняя половина первой карточки — встать перед ней.
  const first = await cards('In progress').first().boundingBox()
  await drag(cards('Backlog').first(), { x: first!.x + first!.width / 2, y: first!.y + 4 })
  await expect(cards('Backlog')).toHaveCount(0)
  await expect(cards('In progress')).toHaveText([/^Первая\s*$/, /^С холста\s*$/])
})

test('агент, соединённый с доской, получает письмо о событиях', async () => {
  const screen = h.page.locator('[data-node-id="agent00000000000"] [data-testid="terminal-screen"]')
  await expect(screen).toContainText('событие на доске', { timeout: 20_000 })
  await expect(screen).toContainText('«Первая» (id c1): «Backlog» → «In progress»')
})

test('двойной клик — редактор: текст и цвет', async () => {
  await cards('In progress').first().dblclick()
  const editor = h.page.getByTestId('card-editor')
  await expect(editor).toBeVisible()
  await editor.locator('.cm-content').click()
  await h.page.keyboard.press('End')
  await h.page.keyboard.type(' — правка')
  await editor.locator('.swatch--4').click()
  await editor.getByTestId('card-save').click()
  await expect(editor).toHaveCount(0)
  await expect(cards('In progress').first()).toHaveText(/^Первая — правка\s*$/)
  await expect(cards('In progress').first()).toHaveClass(/swatch--4/)
})

test('у дорожки свой скролл: колесо крутит список, а не холст', async () => {
  const list = lane('Done').locator('[data-board-lane-scroll]')
  const before = await cameraState(h.page)
  await h.page.mouse.move(...(Object.values(await center(list)) as [number, number]))
  await h.page.mouse.wheel(0, 300)
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(await cameraState(h.page)).toEqual(before)
})

test('карточку утащили на холст — снова обычная карточка', async () => {
  const board = await h.page.getByTestId('board').boundingBox()
  await drag(cards('In progress').last(), {
    x: board!.x + board!.width / 2,
    y: board!.y + board!.height + 120
  })
  await expect(cards('In progress')).toHaveCount(1)
  const doc = await saved()
  expect(doc.nodes.some((n) => n.text === 'С холста' && !n['x-cnv']?.board)).toBe(true)
})

test('новая дорожка и карточка кнопками; файл хранит доску и markdown', async () => {
  await h.page.getByTestId('board-add-lane').click()
  await expect(h.page.getByTestId('board-lane')).toHaveCount(4)
  await lane('Новая дорожка').getByTestId('board-add-card').click()
  const editor = h.page.getByTestId('card-editor')
  await editor.locator('.cm-content').click()
  await h.page.keyboard.type('# Задача\nописание')
  await h.page.keyboard.press('Control+Enter')
  await expect(cards('Новая дорожка')).toHaveCount(1)
  const node = (await saved()).nodes.find((n) => n.id === BOARD)
  expect(node?.text).toContain('### Новая дорожка\n- Задача')
  await h.page.screenshot({ path: path.join(process.env.BOARD_SHOT_DIR ?? tmpdir(), 'board.png') })
})

test('шрифт доски — как у карточек: из настроек, «Aa» задаёт свой', async () => {
  const board = h.page.getByTestId('board')
  await expect(board).toHaveCSS('font-size', '16px')
  await h.page.getByText('Спринт', { exact: true }).click()
  await h.page.getByTestId('node-panel-toggle').click()
  await h.page.locator('[data-action="font"]').getByRole('button', { name: 'M', exact: true }).click()
  await expect(board).toHaveCSS('font-size', '22px')
})
