import { expect, test, type Locator } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fitAll, launchApp, type Harness } from './helpers'

let h: Harness
let userData: string
let workspace: string
let server: { url: string; token: string }
const nodeId = 'paused-agent-test'

async function tool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const result = (await res.json()).result
  if (result.isError) throw new Error(result.content[0].text)
  return JSON.parse(result.content[0].text) as T
}
async function launch(): Promise<void> {
  h = await launchApp({ userDataDir: userData, workspaceDir: workspace })
  server = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8'))
  await fitAll(h.page)
}
const node = (): Locator => h.page.locator(`[data-node-id="${nodeId}"]`)
const log = (): Promise<string> => readFile(path.join(workspace, 'events.log'), 'utf8').catch(() => '')
const running = async (): Promise<boolean> =>
  (await tool<{ id: string; running: boolean }[]>('list_terminals')).some((t) => t.id === nodeId && t.running)

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'cnv-pause-ud-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'cnv-pause-ws-'))
  await mkdir(path.join(userData, 'agents'), { recursive: true })
  // Родитель и дочерняя команда пишут сердцебиения: пауза должна остановить обоих.
  await writeFile(
    path.join(workspace, 'worker.cjs'),
    `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const log = (s) => fs.appendFileSync('events.log', s + '\\n');
if (process.argv[2] !== 'child') {
  log(process.argv[2]);
  spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore' });
}
setInterval(() => log(process.argv[2] === 'child' ? 'child-tick' : 'parent-tick'), 100);
`
  )
  await writeFile(
    path.join(userData, 'agents', 'pause-test.mjs'),
    `
import fs from 'node:fs';
import path from 'node:path';
export default {
  id: 'pause-test', label: 'Pause test', command: 'node',
  start: (c) => c.command + ' worker.cjs START',
  resume: (c) => c.command + ' worker.cjs RESUME-' + c.sessionId,
  getSession: () => 'saved-session', hasSession: () => true,
  deliver: (c, letter) => { fs.appendFileSync(path.join(c.cwd, 'events.log'), 'LETTER:' + letter.id + ':' + letter.text + '\\n'); return true; }
}
`
  )
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: { terminal: { shell: '/bin/sh' } },
      canvasPath: null
    })
  )
  await writeFile(
    path.join(workspace, 'scratchpad.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: nodeId,
          type: 'text',
          text: 'agent',
          x: 100,
          y: 100,
          width: 700,
          height: 500,
          'x-cnv': {
            terminal: {
              name: 'Пробный агент',
              cwd: workspace,
              agent: { plugin: 'pause-test', sessionId: '' }
            }
          }
        }
      ],
      edges: []
    })
  )
  await launch()
})

test.afterAll(async () => {
  await h?.close()
  await rm(userData, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

const paused = (): Promise<string | null> => node().getByTestId('agent-pause').getAttribute('data-paused')
/** Лог не растёт: процессы стоят. */
async function frozen(): Promise<string> {
  await h.page.waitForTimeout(300)
  const at = await log()
  await h.page.waitForTimeout(700)
  expect(await log()).toBe(at)
  return at
}

test('пауза замораживает дерево процессов: без перезапуска, письма ждут, таймер не будит', async () => {
  test.setTimeout(60_000)
  await expect.poll(log).toContain('child-tick')
  await expect
    .poll(async () => (await tool<{ sessionId?: string }[]>('get_nodes', { ids: [nodeId] }))[0]?.sessionId)
    .toBe('saved-session')
  await node().getByTestId('agent-pause').click()
  await expect.poll(paused).toBe('true')
  await expect(node().getByTestId('agent-pause')).toContainText('продолжить')
  await expect(node().locator('.node-term--paused')).toHaveCount(1)
  // Процесс жив, но заморожен — и шелл, и агент, и его дочерняя команда.
  expect(await running()).toBe(true)
  const stopped = await frozen()

  const sent = await tool<{ via: string; recipientPaused: boolean; messageId: string }>('agent_send', {
    id: nodeId,
    message: 'Жди продолжения'
  })
  expect(sent).toMatchObject({ via: 'queued', recipientPaused: true })
  await h.page.evaluate((id) => {
    window.api.agents.timerTick({
      timerId: 'test-timer',
      every: 1,
      message: 'TIMER_WHILE_PAUSED',
      targets: [id]
    })
  }, nodeId)
  // Пауза мимо истории: Ctrl+Z её не снимает.
  await tool('run_command', { id: 'edit.undo' })
  expect(await paused()).toBe('true')
  expect(await log()).toBe(stopped)

  await node().getByTestId('agent-pause').click()
  await expect.poll(paused).toBe('false')
  // Продолжил с того же места: тики пошли, перезапуска не было.
  await expect.poll(async () => (await log()).length).toBeGreaterThan(stopped.length)
  await expect.poll(log).toContain('LETTER:' + sent.messageId)
  expect(await log()).not.toContain('RESUME-')
  await h.page.waitForTimeout(1500)
  expect(await log()).not.toContain('TIMER_WHILE_PAUSED')
})

test('пауза переживает перезапуск cnv: агент не стартует, ▶ продолжает сохранённую сессию', async () => {
  test.setTimeout(60_000)
  await tool('update_node', { id: nodeId, paused: true })
  await expect.poll(paused).toBe('true')
  await frozen()
  await tool('save')
  await h.close()
  await launch()
  await expect.poll(paused).toBe('true')
  expect(await running()).toBe(false)
  const sent = await tool<{ via: string; messageId: string }>('agent_send', {
    id: nodeId,
    message: 'После перезапуска'
  })
  expect(sent.via).toBe('queued')
  const before = await frozen()
  expect(before).not.toContain('RESUME-')

  // Свернуть можно и на паузе: кружок с ⏸ в углу.
  await tool('update_node', { id: nodeId, collapsed: true })
  await expect(node().getByTestId('agent-mini')).toHaveAttribute('data-state', 'paused')
  await expect(node().locator('.node-mini__paused')).toHaveCount(1)
  await tool('update_node', { id: nodeId, collapsed: false })

  await node().getByTestId('agent-pause').click()
  await expect.poll(running).toBe(true)
  await expect.poll(log).toContain('RESUME-saved-session')
  await expect.poll(log).toContain('LETTER:' + sent.messageId)
})
