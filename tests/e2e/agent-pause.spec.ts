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

test('пауза останавливает дерево процессов, сохраняется после перезапуска и держит письма до продолжения', async () => {
  test.setTimeout(60_000)
  await expect.poll(log).toContain('child-tick')
  await expect
    .poll(async () => (await tool<{ sessionId?: string }[]>('get_nodes', { ids: [nodeId] }))[0]?.sessionId)
    .toBe('saved-session')
  await node().getByTestId('agent-pause').first().click()
  await expect(node().getByTestId('agent-paused')).toBeVisible()
  await expect.poll(running).toBe(false)
  await h.page.waitForTimeout(300)
  const stopped = await log()
  await h.page.waitForTimeout(600)
  expect(await log()).toBe(stopped)

  const sent = await tool<{ via: string; recipientPaused: boolean; messageId: string }>('agent_send', {
    id: nodeId,
    message: 'Жди продолжения'
  })
  expect(sent).toMatchObject({ via: 'queued', recipientPaused: true })
  // Событие доски сохраняется в очереди; тики таймера не будят остановленный процесс.
  await h.page.evaluate((id) => {
    window.api.agents.notify({
      notices: [{ nodeId: id, text: 'BOARD_WHILE_PAUSED' }],
      by: ['тест'],
      about: 'board'
    })
    window.api.agents.timerTick({
      timerId: 'test-timer',
      every: 1,
      message: 'TIMER_WHILE_PAUSED',
      targets: [id]
    })
  }, nodeId)

  await tool('save')
  await h.close()
  await launch()
  await expect(node().getByTestId('agent-paused')).toBeVisible()
  expect(await running()).toBe(false)
  await h.page.waitForTimeout(1200)
  expect(await log()).toBe(stopped)
  await node().getByTestId('agent-pause').first().click()
  await expect(node().getByTestId('agent-paused')).toHaveCount(0)
  await expect.poll(log).toContain('RESUME-saved-session')
  await expect.poll(log).toContain('LETTER:' + sent.messageId)
  await expect.poll(log).toContain('тебя включили — сняли с паузы')
  await expect.poll(log).toContain('BOARD_WHILE_PAUSED')
  expect(await log()).not.toContain('TIMER_WHILE_PAUSED')
  expect((await log()).split('LETTER:' + sent.messageId).length - 1).toBe(1)

  // Свернуть можно и на паузе; мини-вид показывает паузу. Смена модели её не снимает.
  await tool('update_node', { id: nodeId, paused: true, collapsed: true })
  await expect(node().getByTestId('agent-mini')).toHaveAttribute('data-state', 'paused')
  await tool('update_node', { id: nodeId, model: 'test-model' })
  expect(await running()).toBe(false)
  await tool('update_node', { id: nodeId, paused: false })
  await expect.poll(running).toBe(true)
})
