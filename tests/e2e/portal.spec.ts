import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'
import { startNostrRelay } from './nostr-relay'

/**
 * Два cnv, у каждого — агент и портал с одним ключом. Знакомятся через локальный
 * Nostr-ретранслятор, люди пускают друг друга, агенты переписываются через портал.
 */

const KEY = 'TEST-PRTL-KEY2-2026'
// Агент-заглушка: печатает READY и оставляет шелл — письма видно на экране.
const FAKE = `export default {
  id: 'fake', label: 'Фейк', command: 'echo',
  start: (c) => 'echo READY', resume: () => 'echo READY', getSession: (q) => 'fake-' + q.nodeId
}`

interface Side {
  h: Harness
  dir: string
  mcp: { url: string; token: string }
}

let relay: Awaited<ReturnType<typeof startNostrRelay>>
let alpha: Side
let beta: Side

test.describe.configure({ mode: 'serial', timeout: 120_000 })

async function launchSide(name: string, agentName: string): Promise<Side> {
  const dir = await mkdtemp(path.join(tmpdir(), `cnv-portal-${name}-`))
  const userData = path.join(dir, 'ud')
  const workspace = path.join(dir, 'ws')
  await mkdir(path.join(userData, 'agents'), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(userData, 'agents', 'fake.mjs'), FAKE)
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: {
        portal: { deviceName: name, relays: [relay.url] },
        terminal: { shell: '/bin/sh' }
      },
      canvasPath: null
    })
  )
  await writeFile(
    path.join(workspace, 'scratchpad.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: `agent${name}000000`,
          type: 'text',
          text: '`агент`',
          x: 0,
          y: 0,
          width: 600,
          height: 360,
          'x-cnv': { terminal: { name: agentName, agent: { plugin: 'fake', sessionId: '' } } }
        },
        {
          id: `portal${name}00000`,
          type: 'text',
          text: '`портал`',
          x: 700,
          y: 0,
          width: 320,
          height: 340,
          'x-cnv': { portal: { key: KEY, label: `Дверь ${name}`, trusted: [] } }
        }
      ],
      edges: [{ id: `edge${name}0000000`, fromNode: `agent${name}000000`, toNode: `portal${name}00000` }]
    })
  )
  const h = await launchApp({ userDataDir: userData, workspaceDir: workspace })
  const mcp = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as Side['mcp']
  return { h, dir, mcp }
}

async function tool<T>(
  side: Side,
  name: string,
  args: Record<string, unknown>,
  token = side.mcp.token
): Promise<T> {
  const res = await fetch(side.mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = (await res.json()) as { result: { content: { text?: string }[]; isError?: boolean } }
  const text = body.result.content[0]?.text ?? ''
  if (body.result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

/** Токен агента: от его имени и зовём MCP — так видно, к какому порталу он подключён. */
async function agentToken(side: Side, agentId: string): Promise<string> {
  await tool(side, 'terminal_send', { id: agentId, text: 'echo "TOKEN=$CNV_MCP_TOKEN"' })
  let token = ''
  await expect
    .poll(
      async () => {
        const { text } = await tool<{ text: string }>(side, 'terminal_read', { id: agentId })
        token = /^TOKEN=(\S+)/m.exec(text)?.[1] ?? ''
        return token
      },
      { timeout: 15000 }
    )
    .not.toBe('')
  return token
}

const portal = (side: Side): ReturnType<Harness['page']['locator']> => side.h.page.getByTestId('portal')

test.beforeAll(async () => {
  relay = await startNostrRelay()
  alpha = await launchSide('Альфа', 'Агент Альфа')
  beta = await launchSide('Бета', 'Агент Бета')
})

test.afterAll(async () => {
  for (const side of [alpha, beta]) {
    await side?.h.close()
    if (side) await rm(side.dir, { recursive: true, force: true })
  }
  await relay?.close()
})

test('порталы с одним ключом находят друг друга, люди пускают — соединены', async () => {
  for (const side of [alpha, beta]) {
    await expect(portal(side)).toHaveAttribute('data-status', 'confirm', { timeout: 60_000 })
  }
  // Каждый видит визитку другой стороны — имя cnv.
  await expect(portal(alpha)).toContainText('Бета')
  await expect(portal(beta)).toContainText('Альфа')
  await alpha.h.page.getByTestId('portal-trust').click()
  await beta.h.page.getByTestId('portal-trust').click()
  for (const side of [alpha, beta]) {
    await expect(portal(side)).toHaveAttribute('data-status', 'connected', { timeout: 15_000 })
  }
  // С той стороны виден подключённый к порталу агент.
  await expect(portal(alpha).getByTestId('portal-remote')).toHaveText('✦ Агент Бета')
  await expect(portal(beta).getByTestId('portal-remote')).toHaveText('✦ Агент Альфа')

  // Доверие запомнено в .canvas — второй раз спрашивать не будут.
  await alpha.h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  const saved = JSON.parse(await readFile(alpha.h.canvasFile, 'utf8')) as {
    nodes: { 'x-cnv'?: { portal?: { trusted: { name: string }[] } } }[]
  }
  const trusted = saved.nodes.find((n) => n['x-cnv']?.portal)?.['x-cnv']?.portal?.trusted ?? []
  expect(trusted.map((t) => t.name)).toEqual(['Бета'])
})

test('агент пишет через портал, ответ возвращается по wait_reply', async () => {
  const alphaAgent = 'agentАльфа000000'
  const betaAgent = 'agentБета000000'
  const tokenA = await agentToken(alpha, alphaAgent)
  const tokenB = await agentToken(beta, betaAgent)

  // Агент видит, кто на той стороне портала.
  const links = await tool<{ peer: { portal?: { remote: { id: string; name: string }[] } } }[]>(
    alpha,
    'connections',
    {},
    tokenA
  )
  const remote = links.find((l) => l.peer.portal)?.peer.portal?.remote ?? []
  expect(remote.map((r) => r.name)).toEqual(['Агент Бета'])

  const sent = await tool<{ messageId: string; via: { portal: string; peer: string } }>(
    alpha,
    'agent_send',
    { id: 'Агент Бета', message: 'PORTAL_HELLO привет с той стороны', data: { rows: [1, 2, 3] } },
    tokenA
  )
  expect(sent.via).toEqual({ portal: 'Дверь Альфа', peer: 'Бета' })
  await expect
    .poll(async () => (await tool<{ text: string }>(beta, 'terminal_read', { id: betaAgent })).text, {
      timeout: 15_000
    })
    .toContain('PORTAL_HELLO')
  const screen = (await tool<{ text: string }>(beta, 'terminal_read', { id: betaAgent, lines: 60 })).text
  expect(screen).toContain('с той стороны портала «Дверь Бета» (Альфа)')

  // Бета читает письмо — данные пришли разобранными.
  const inbox = await tool<{ id: string; from: string; text: string }[]>(beta, 'inbox', {}, tokenB)
  const letter = inbox.find((m) => m.text.startsWith('PORTAL_HELLO'))!
  const read = await tool<{ data: unknown }>(beta, 'read_message', { id: letter.id }, tokenB)
  expect(read.data).toEqual({ rows: [1, 2, 3] })

  // Альфа ждёт ответа, Бета отвечает — по адресу из письма.
  const waiting = tool<{ reply: { text: string } }>(
    alpha,
    'wait_reply',
    { id: sent.messageId, timeout_s: 20 },
    tokenA
  )
  await tool(
    beta,
    'agent_send',
    { id: letter.from, message: 'PORTAL_REPLY принял', reply_to: letter.id },
    tokenB
  )
  expect((await waiting).reply.text).toBe('PORTAL_REPLY принял')
})

test('без стрелки к порталу агент ту сторону не видит и писать туда не может', async () => {
  const lone = await tool<{ id: string }>(alpha, 'create_node', {
    kind: 'agent',
    agent: 'fake',
    x: 0,
    y: 800
  })
  const token = await agentToken(alpha, lone.id)
  await expect(
    tool(alpha, 'agent_send', { id: 'Агент Бета', message: 'не должно дойти' }, token)
  ).rejects.toThrow(/нет терминала или агента/)
})

test('после перезапуска доверенные порталы соединяются сами, без вопроса', async () => {
  const dir = alpha.dir
  await alpha.h.close()
  const h = await launchApp({ userDataDir: path.join(dir, 'ud'), workspaceDir: path.join(dir, 'ws') })
  alpha = { ...alpha, h }
  await expect(portal(alpha)).toHaveAttribute('data-status', 'connected', { timeout: 60_000 })
  await expect(portal(beta)).toHaveAttribute('data-status', 'connected', { timeout: 15_000 })
  await expect(portal(alpha).getByTestId('portal-remote')).toHaveText('✦ Агент Бета')
  await alpha.h.page.screenshot({
    path: path.join(process.env.PORTAL_SHOT_DIR ?? tmpdir(), 'portal-connected.png')
  })
})

test('в настройках портала: два ретранслятора вводятся построчно, отпечаток виден', async () => {
  await alpha.h.page.keyboard.press('Control+,')
  const field = alpha.h.page.locator('[data-setting="portalRelays"]')
  await field.fill('')
  await field.type('wss://one.example\nwss://two.example')
  await expect(field).toHaveValue('wss://one.example\nwss://two.example')
  await alpha.h.page.getByTestId('portal-settings').locator('code').first().waitFor()
  await expect(alpha.h.page.getByTestId('portal-settings')).toContainText(
    /[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}/
  )
  await field.blur()
  await expect
    .poll(() => alpha.h.page.evaluate(() => window.api.settings.get().then((s) => s.portal.relays)))
    .toEqual(['wss://one.example', 'wss://two.example'])
})
