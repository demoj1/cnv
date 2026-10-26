import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { agentSystemPrompt } from '../../src/main/agent-session'
import { launchApp, type Harness } from './helpers'

/**
 * Kimi Code через настоящую проводку cnv, но с поддельным `kimi`: скрипт рисует поле ввода,
 * как Kimi, принимает вставку и с первым сообщением заводит сессию в KIMI_CODE_HOME — как
 * настоящий. Проверяем: мост cnv-mcp в mcp.json Kimi (чужие серверы целы), первое сообщение —
 * системный промпт и задание — вставляется в пустое поле один раз, id сессии ложится в .canvas,
 * после перезапуска — `--session <id>`, и первое сообщение не повторяется.
 * KIMI_CODE_HOME — временная папка: настоящий ~/.kimi-code тест не трогает.
 */

test.describe.configure({ mode: 'serial' })

let h: Harness
let userData: string
let workspace: string
let kimiHome: string
let bin: string
let server: { url: string; token: string }

/**
 * Поддельный Kimi: рамка поля ввода — как у Kimi; вставка приходит `\x1b[200~…\x1b[201~`, Enter —
 * отдельно. Каждое отправленное сообщение и каждый запуск пишет в `<KIMI_CODE_HOME>/fake-kimi.jsonl`.
 */
const FAKE_KIMI = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const home = process.env.KIMI_CODE_HOME
if (!home) {
  process.stdout.write('FAKE_KIMI_NO_HOME\r\n')
  process.exit(1)
}
const args = process.argv.slice(2)
const at = args.indexOf('--session')
let session = at >= 0 ? args[at + 1] : null
const note = (entry) =>
  fs.appendFileSync(
    path.join(home, 'fake-kimi.jsonl'),
    JSON.stringify({ node: process.env.CNV_NODE_ID, pid: process.pid, ...entry }) + '\n'
  )
const out = (s) => process.stdout.write(s)
const box = () =>
  out(' ╭' + '─'.repeat(30) + '╮\r\n │ >' + ' '.repeat(28) + '│\r\n ╰' + '─'.repeat(30) + '╯\r\n')
const stateFile = (id) => path.join(home, 'sessions', 'wd_fake_000000000000', id, 'state.json')

// Как Kimi Code 2.3: title — первое сообщение в одну строку (до 200 символов), lastPrompt — последнее.
const flat = (s) => s.replace(/\s+/g, ' ').trim()
function save(id, text) {
  let old = null
  try {
    old = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'))
  } catch {}
  const now = Date.now()
  const state = { id, cwd: process.cwd(), createdAt: now, title: flat(text).slice(0, 200), archived: false }
  fs.mkdirSync(path.dirname(stateFile(id)), { recursive: true })
  fs.writeFileSync(stateFile(id), JSON.stringify({ ...state, ...old, updatedAt: now, lastPrompt: flat(text) }))
}

function submit(text, pastes) {
  session = session || 'session_' + crypto.randomUUID()
  // FAKE_KIMI_DELAY=<мс> в сообщении — сессия появится на диске с задержкой: так агенты,
  // запущенные разом, заводят сессии не в том порядке, в каком стартовали.
  const delay = Number((/FAKE_KIMI_DELAY=(\d+)/.exec(text) || [])[1] || 0)
  const id = session
  if (delay) setTimeout(() => save(id, text), delay)
  else save(id, text)
  note({ event: 'message', session, text, pastes })
  out('FAKE_KIMI_GOT: ' + text.split('\n')[0].slice(0, 40) + ' [' + text.length + ', вставок ' + pastes + ']\r\n')
  box()
}

note({ event: 'start', args, cwd: process.cwd() })
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
out((session ? 'FAKE_KIMI_RESUME ' + session : 'FAKE_KIMI_START') + '\r\n')
// Файл late-box в KIMI_CODE_HOME — поле ввода появится, только когда рядом ляжет allow-box:
// так тест держит агента «на диалоге», пока ему пишут письмо.
if (fs.existsSync(path.join(home, 'late-box'))) {
  const allow = setInterval(() => {
    if (!fs.existsSync(path.join(home, 'allow-box'))) return
    clearInterval(allow)
    box()
  }, 200)
} else box()

const START = '\x1b[200~'
const END = '\x1b[201~'
let raw = ''
let text = ''
let pastes = 0
process.stdin.on('data', (chunk) => {
  raw += chunk
  for (;;) {
    if (raw.startsWith(START)) {
      const end = raw.indexOf(END)
      if (end < 0) return
      text += raw.slice(START.length, end)
      pastes++
      raw = raw.slice(end + END.length)
      continue
    }
    if (!raw || START.startsWith(raw)) return
    const ch = raw[0]
    raw = raw.slice(1)
    if (ch === '\x03') process.exit(0)
    if (ch === '\r') {
      // Пустой Enter Kimi игнорирует — и мы: иначе случайный возврат каретки рождал бы
      // пустое «сообщение» и путал порядок в тестах.
      if (text) submit(text, pastes)
      text = ''
      pastes = 0
    } else text += ch
  }
})
process.stdin.on('end', () => process.exit(0))
`

/** Чужие серверы в mcp.json Kimi: cnv дописывает свой рядом и их не трогает. */
const SEEDED = {
  chrome: { command: 'npx', args: ['-y', 'chrome-devtools-mcp'] },
  kaiten: {
    command: '/usr/bin/python3',
    args: ['-u', '/opt/mcp-kaiten/server.py'],
    env: { PYTHONUNBUFFERED: '1' }
  }
}

const PROMPT = 'Проверь поддельный Kimi\nвторой строкой — задание целиком'
const ROLE = 'проверяет Kimi'

/** Как Kimi пишет сообщение в title и lastPrompt: пробелы и переводы строк — одним пробелом. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

interface FakeEvent {
  event: 'start' | 'message'
  node?: string
  pid: number
  args?: string[]
  cwd?: string
  session?: string
  text?: string
  pastes?: number
}

interface ToolResult {
  content: { type: string; text?: string }[]
  isError?: boolean
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const body = (await res.json()) as { result?: unknown; error?: unknown }
  if (body.error) throw new Error(JSON.stringify(body.error))
  return body.result
}

async function tool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await rpc('tools/call', { name, arguments: args })) as ToolResult
  const text = result.content[0]?.text ?? ''
  if (result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

/** Что поддельный Kimi делал в этой ноде: запуски и полученные сообщения. */
async function fakeEvents(node: string, event: FakeEvent['event']): Promise<FakeEvent[]> {
  let text = ''
  try {
    text = await readFile(path.join(kimiHome, 'fake-kimi.jsonl'), 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent)
    .filter((e) => e.node === node && e.event === event)
}

type McpServers = Record<string, { command: string; args?: string[]; env?: object; timeout?: number }>

const kimiMcp = async (): Promise<McpServers> =>
  (JSON.parse(await readFile(path.join(kimiHome, 'mcp.json'), 'utf8')) as { mcpServers: McpServers })
    .mcpServers

const canvasAgent = async (id: string): Promise<object | undefined> => {
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  const doc = JSON.parse(await readFile(h.canvasFile, 'utf8')) as {
    nodes: { id: string; 'x-cnv'?: { terminal?: { agent?: object } } }[]
  }
  return doc.nodes.find((n) => n.id === id)?.['x-cnv']?.terminal?.agent
}

const screen = (id: string): Promise<string> =>
  h.page.locator(`[data-node-id="${id}"] [data-testid="terminal-screen"]`).innerText()

/** Сессии, которые cnv записал в ноды, — когда записал во все. */
async function savedSessions(ids: string[]): Promise<Record<string, string | undefined>> {
  const read = async (): Promise<Record<string, string | undefined>> => {
    const nodes = await tool<{ sessionId?: string }[]>('get_nodes', { ids })
    return Object.fromEntries(ids.map((id, i) => [id, nodes[i]?.sessionId]))
  }
  await expect.poll(async () => Object.values(await read()).every(Boolean), { timeout: 20000 }).toBe(true)
  return read()
}

/**
 * Несколько Kimi в одной папке подряд, без пауз: все стартуют до первой вставки. Задержка в
 * задании переворачивает порядок — кто стартовал первым, у того сессия появляется на диске
 * последней. Ответ — нода → сессия, которую завёл её собственный Kimi (по журналу с CNV_NODE_ID).
 */
async function kimiCrowd(label: string, count: number): Promise<Record<string, string>> {
  const created: { id: string; name: string }[] = []
  for (let i = 0; i < count; i++) {
    created.push(
      await tool<{ id: string; name: string }>('create_node', {
        kind: 'agent',
        agent: 'kimi',
        cwd: workspace,
        prompt: `${label}, агент ${i}. FAKE_KIMI_DELAY=${(count - 1 - i) * 600}`,
        x: 1200 + i * 700,
        y: 0
      })
    )
  }
  // Агентов различает имя в первом сообщении.
  expect(new Set(created.map((a) => a.name)).size).toBe(count)
  const own: Record<string, string> = {}
  for (const { id } of created) {
    await expect.poll(async () => (await fakeEvents(id, 'message')).length, { timeout: 20000 }).toBe(1)
    own[id] = (await fakeEvents(id, 'message'))[0]!.session!
  }
  return own
}

/** Мост cnv-mcp этого запуска cnv — он лежит в папке данных. */
const bridge = (): string => path.join(userData, 'mcp', 'bin', 'cnv-mcp')

const launch = async (): Promise<Harness> => {
  const harness = await launchApp({
    userDataDir: userData,
    workspaceDir: workspace,
    env: { KIMI_CODE_HOME: kimiHome }
  })
  // Без своего KIMI_CODE_HOME cnv писал бы в настоящий ~/.kimi-code — дальше не идём.
  const seen = await harness.app.evaluate(() => process.env.KIMI_CODE_HOME)
  if (seen !== kimiHome) {
    await harness.app.close()
    throw new Error(`cnv не получил KIMI_CODE_HOME: ${seen}`)
  }
  server = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as typeof server
  return harness
}

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'cnv-ud-kimi-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'cnv-ws-kimi-'))
  kimiHome = await mkdtemp(path.join(tmpdir(), 'cnv-kimi-home-'))
  bin = await mkdtemp(path.join(tmpdir(), 'cnv-kimi-bin-'))
  await writeFile(path.join(bin, 'kimi'), FAKE_KIMI, { mode: 0o755 })
  await writeFile(path.join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: SEEDED }, null, 2))
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: { agents: { commands: { kimi: path.join(bin, 'kimi') } }, terminal: { shell: '/bin/sh' } },
      canvasPath: null
    })
  )
  await writeFile(path.join(workspace, 'scratchpad.canvas'), JSON.stringify({ nodes: [], edges: [] }))
  h = await launch()
})

test.afterAll(async () => {
  await h?.close()
  for (const dir of [userData, workspace, kimiHome, bin]) await rm(dir, { recursive: true, force: true })
})

let kimiId = ''
let sessionId = ''

test('Kimi с заданием: мост cnv-mcp в mcp.json, первое сообщение — в пустое поле, один раз', async () => {
  const agent = await tool<{ id: string; name: string }>('create_node', {
    kind: 'agent',
    agent: 'kimi',
    cwd: workspace,
    role: ROLE,
    prompt: PROMPT,
    x: 0,
    y: 0
  })
  kimiId = agent.id
  await expect(h.page.locator(`[data-node-id="${kimiId}"]`).getByTestId('terminal-agent')).toHaveText(
    'Kimi Code'
  )
  await expect.poll(() => screen(kimiId), { timeout: 20000 }).toContain('FAKE_KIMI_START')
  const [start] = await fakeEvents(kimiId, 'start')
  expect(start).toMatchObject({ args: [], cwd: workspace })

  // Холст — в mcp.json Kimi: stdio-мост этого cnv; серверы человека — как были.
  expect(await kimiMcp()).toEqual({ ...SEEDED, cnv: { command: bridge() } })
  expect(path.basename((await kimiMcp()).cnv!.command)).toMatch(/^cnv-mcp(\.cmd)?$/)

  // Ни задания, ни системного промпта флагами Kimi не берёт: cnv вставляет их первым сообщением.
  await expect.poll(async () => (await fakeEvents(kimiId, 'message')).length, { timeout: 20000 }).toBe(1)
  const [first] = await fakeEvents(kimiId, 'message')
  expect(first!.text).toBe(`${agentSystemPrompt(agent.name, ROLE)}\n\nПервое задание:\n${PROMPT}`)
  expect(first!.text).toContain('Ты — агент')
  // Одной вставкой (переводы строк задания не отправили его по кусочкам) и Enter после неё.
  expect(first!.pastes).toBe(1)
  await expect.poll(() => screen(kimiId)).toContain('FAKE_KIMI_GOT: Ты — агент')

  // Поле ввода снова пустое, а второго первого сообщения нет.
  await h.page.waitForTimeout(3000)
  expect(await fakeEvents(kimiId, 'message')).toHaveLength(1)
  sessionId = first!.session!
  expect(sessionId).toMatch(/^session_[0-9a-f-]{36}$/)
})

test('сессия Kimi из его state.json — в .canvas и в списке сессий', async () => {
  await expect.poll(() => canvasAgent(kimiId), { timeout: 20000 }).toEqual({ plugin: 'kimi', sessionId })
  const [node] = await tool<{ sessionId?: string; agent?: string }[]>('get_nodes', { ids: [kimiId] })
  expect(node).toMatchObject({ agent: 'kimi', sessionId })
  const listed = await tool<{ agent: string; current: string; sessions: { id: string; title?: string }[] }>(
    'list_agent_sessions',
    { id: kimiId }
  )
  expect(listed).toMatchObject({ agent: 'kimi', current: sessionId })
  // Заголовок Kimi — первое сообщение, а в нём системный промпт: человеку показываем задание.
  expect(listed.sessions).toEqual([expect.objectContaining({ id: sessionId, title: flat(PROMPT) })])
})

test('Kimi из списка агентов без задания — «Задания пока нет»', async () => {
  const before = await h.page.locator('[data-node-kind="terminal"]').count()
  await h.page.locator('.create-bar__item[data-kind="agent"]').click({ button: 'right' })
  await h.page.getByTestId('create-agents').locator('[data-agent="kimi"]').click()
  await expect(h.page.locator('[data-node-kind="terminal"]')).toHaveCount(before + 1, { timeout: 15000 })
  const created = h.page.locator('[data-node-kind="terminal"]').last()
  const id = (await created.getAttribute('data-node-id'))!
  expect(id).not.toBe(kimiId)
  await expect(created.getByTestId('terminal-agent')).toHaveText('Kimi Code')

  await expect.poll(async () => (await fakeEvents(id, 'message')).length, { timeout: 20000 }).toBe(1)
  const [first] = await fakeEvents(id, 'message')
  expect(first!.text).toMatch(/^Ты — агент «[^»]+» на бесконечном холсте/)
  expect(first!.text).toMatch(/\n\nЗадания пока нет: ответь одной строкой и жди\.$/)
  expect(first!.text).not.toContain('Первое задание')
  // Своя сессия, не та, что у первого Kimi.
  await expect
    .poll(async () => (await tool<{ sessionId?: string }[]>('get_nodes', { ids: [id] }))[0]?.sessionId, {
      timeout: 20000
    })
    .toBe(first!.session)
  expect(first!.session).not.toBe(sessionId)

  // Убираем: он встал по центру и после перезапуска только мешал бы.
  await tool('delete', { ids: [id] })
  await expect(h.page.locator(`[data-node-id="${id}"]`)).toHaveCount(0)
})

test('письмо до появления поля ввода приходит после первого сообщения', async () => {
  // Поддельный Kimi без поля ввода: рамка появится, только когда ляжет allow-box.
  await writeFile(path.join(kimiHome, 'late-box'), '')
  const agent = await tool<{ id: string }>('create_node', {
    kind: 'agent',
    agent: 'kimi',
    cwd: workspace,
    prompt: 'позднее поле ввода',
    x: 0,
    y: 1400
  })
  const id = agent.id
  try {
    await expect.poll(async () => (await fakeEvents(id, 'start')).length, { timeout: 20000 }).toBe(1)

    // Поля нет — первое сообщение ждёт; письмо встаёт в очередь за ним, а не раньше.
    const sent = await tool<{ via: string }>('agent_send', { id, message: 'LETTER_AFTER_FIRST' })
    expect(sent.via).toBe('queued')
    await h.page.waitForTimeout(3000)
    expect(await fakeEvents(id, 'message')).toHaveLength(0)

    // Поле появилось: сначала системный промпт с заданием, за ним — письмо.
    await writeFile(path.join(kimiHome, 'allow-box'), '')
    await expect.poll(async () => (await fakeEvents(id, 'message')).length, { timeout: 20000 }).toBe(2)
    const events = (await fakeEvents(id, 'message')).map((e) => `${e.pastes} вставок: ${e.text}`)
    expect(events[0]).toContain('Ты — агент')
    expect(events[0]).toContain('позднее поле ввода')
    expect(events[1]).toContain('LETTER_AFTER_FIRST')
  } finally {
    await rm(path.join(kimiHome, 'late-box'), { force: true })
    await rm(path.join(kimiHome, 'allow-box'), { force: true })
    await tool('delete', { ids: [id] }).catch(() => {})
  }
})

let crowd: Record<string, string> = {}

test('несколько Kimi разом в одной папке — у каждого сессия, которую завёл его Kimi', async () => {
  crowd = await kimiCrowd('Первая волна', 3)
  expect(new Set(Object.values(crowd)).size).toBe(3)
  expect(await savedSessions(Object.keys(crowd))).toEqual(crowd)
})

test('удалили и сразу завели новых в той же папке — сессии удалённых им не достаются', async () => {
  await tool('delete', { ids: Object.keys(crowd) })
  const next = await kimiCrowd('Вторая волна', 3)
  const saved = await savedSessions(Object.keys(next))
  expect(saved).toEqual(next)
  for (const s of Object.values(saved)) expect([...Object.values(crowd), sessionId]).not.toContain(s)
  await tool('delete', { ids: Object.keys(next) })
})

test('после перезапуска — kimi --session <id>, первое сообщение не повторяется', async () => {
  await h.app.close()
  // Мост от другой установки cnv: команда, аргументы и окружение — нынешние, свои поля записи остаются.
  const stale = { command: '/старый/cnv/mcp/bin/cnv-mcp', args: ['--old'], env: { OLD: '1' }, timeout: 30000 }
  await writeFile(
    path.join(kimiHome, 'mcp.json'),
    JSON.stringify({ mcpServers: { ...(await kimiMcp()), cnv: stale } })
  )
  h = await launch()

  await expect.poll(() => screen(kimiId), { timeout: 20000 }).toContain(`FAKE_KIMI_RESUME ${sessionId}`)
  const starts = await fakeEvents(kimiId, 'start')
  expect(starts).toHaveLength(2)
  expect(starts[1]).toMatchObject({ args: ['--session', sessionId], cwd: workspace })
  expect(await kimiMcp()).toEqual({ ...SEEDED, cnv: { command: bridge(), timeout: 30000 } })

  // Поле ввода пустое, но это продолжение разговора: системный промпт второй раз не вставляется.
  await h.page.waitForTimeout(3000)
  expect(await fakeEvents(kimiId, 'message')).toHaveLength(1)
  await expect.poll(() => canvasAgent(kimiId)).toEqual({ plugin: 'kimi', sessionId })
})
