import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Таймер: кружок с обратным отсчётом, раз в N минут шлёт письмо агентам по связям.
 * Агент — заглушка: печатает READY и оставляет шелл, письмо видно на его экране.
 */

const FAKE = `export default {
  id: 'fake', label: 'Фейк', command: 'echo',
  start: () => 'echo READY', resume: () => 'echo READY', getSession: (q) => 'fake-' + q.nodeId
}`

let h: Harness
let dir: string

test.describe.configure({ timeout: 60_000 })

test.beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cnv-timer-'))
  const userData = path.join(dir, 'ud')
  const workspace = path.join(dir, 'ws')
  await mkdir(path.join(userData, 'agents'), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(userData, 'agents', 'fake.mjs'), FAKE)
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({ settings: { terminal: { shell: '/bin/sh' } }, canvasPath: null })
  )
  await writeFile(
    path.join(workspace, 'scratchpad.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: 'agent00000000000',
          type: 'text',
          text: '`агент`',
          x: 0,
          y: 0,
          width: 600,
          height: 360,
          'x-cnv': { terminal: { name: 'Агент', agent: { plugin: 'fake', sessionId: '' } } }
        },
        {
          id: 'timer00000000000',
          type: 'text',
          text: '`таймер`',
          x: 700,
          y: 0,
          width: 160,
          height: 200,
          // Минутный таймер, запущенный 45 с назад: первый тик — секунд через 15.
          'x-cnv': { timer: { every: 1, message: 'TIMER_PING', since: Date.now() - 45_000 } }
        }
      ],
      edges: [{ id: 'edge000000000000', fromNode: 'timer00000000000', toNode: 'agent00000000000' }]
    })
  )
  h = await launchApp({ userDataDir: userData, workspaceDir: workspace })
})

test.afterAll(async () => {
  await h?.close()
  await rm(dir, { recursive: true, force: true })
})

const timer = (): ReturnType<Harness['page']['locator']> =>
  h.page.locator('[data-node-id="timer00000000000"]')

test('отсчёт идёт, тик — письмом агенту по связи', async () => {
  await expect(timer().getByTestId('timer-left')).toHaveText(/^0:\d\d$/)
  const screen = h.page.locator('[data-node-id="agent00000000000"] [data-testid="terminal-screen"]')
  await expect(screen).toContainText('READY', { timeout: 15_000 })
  await expect(screen).toContainText('TIMER_PING', { timeout: 30_000 })
  await expect(screen).toContainText('[таймер timer00000000000')
})

test('✎ — интервал и текст, ⏸ — пауза; всё в файле', async () => {
  await timer().getByTestId('timer-edit').click()
  await timer().getByTestId('timer-every').fill('5')
  await timer().getByTestId('timer-message').fill('проверь CI')
  await timer().getByTestId('timer-save').click()
  await expect(timer().getByTestId('timer-left')).toHaveText(/^[45]:\d\d$/)
  await timer().getByTestId('timer-pause').click()
  await expect(timer().getByTestId('timer')).toHaveAttribute('data-state', 'paused')
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  const saved = JSON.parse(await readFile(h.canvasFile, 'utf8')) as {
    nodes: { id: string; text: string; 'x-cnv'?: { timer?: object } }[]
  }
  const node = saved.nodes.find((n) => n.id === 'timer00000000000')
  expect(node?.['x-cnv']?.timer).toMatchObject({ every: 5, message: 'проверь CI', paused: true })
  expect(node?.text).toBe('`таймер · каждые 5 мин`')
})

test('панель создания — новый таймер с пустым сообщением', async () => {
  await h.page.locator('.create-bar__item[data-kind="timer"]').click()
  const fresh = h.page.locator('[data-node-kind="timer"]')
  await expect(fresh).toHaveCount(2)
  await expect(fresh.last().getByTestId('timer')).toHaveAttribute('data-state', 'idle')
  await expect(fresh.last()).toContainText('впиши сообщение')
  await h.page.screenshot({ path: path.join(process.env.TIMER_SHOT_DIR ?? tmpdir(), 'timer.png') })
})
