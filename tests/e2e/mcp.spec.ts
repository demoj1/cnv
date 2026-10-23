import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * MCP холста целиком, на живом приложении: агент снаружи и агент из терминала на холсте
 * видят и меняют документ, терминал знает, кто он, а stdio-мост `cnv-mcp` ходит туда же.
 */

let h: Harness
let userData: string
let server: { url: string; token: string }

interface ToolResult {
  content: { type: string; text?: string }[]
  isError?: boolean
}

async function rpc(method: string, params: unknown, token = server.token): Promise<unknown> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'cnv-ud-mcp-'))
  // Агент в тесте — `echo`: проверяем командную строку запуска, а не живого Claude.
  await mkdir(userData, { recursive: true })
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: { agents: { command: 'echo' }, terminal: { shell: '/bin/sh' } },
      canvasPath: null
    })
  )
  h = await launchApp({ userDataDir: userData, canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
  server = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as typeof server
})

test.afterAll(async () => {
  await h?.close()
  await rm(userData, { recursive: true, force: true })
})

test('initialize и список инструментов', async () => {
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })) as {
    instructions: string
  }
  expect(init.instructions).toContain('cnv')
  const { tools } = (await rpc('tools/list', {})) as { tools: { name: string }[] }
  expect(tools.map((t) => t.name)).toEqual(
    expect.arrayContaining(['whoami', 'get_canvas', 'create_node', 'terminal_read', 'screenshot'])
  )
})

test('агент создаёт карточку и связь — они на холсте и в файле', async () => {
  const a = await tool<{ id: string }>('create_node', { kind: 'text', text: 'от агента', x: 0, y: 0 })
  const b = await tool<{ id: string }>('create_node', {
    kind: 'text',
    text: 'второй',
    x: 400,
    y: 0,
    color: '4'
  })
  await tool('create_edge', { from: a.id, to: b.id, label: 'связь' })
  await expect(h.page.locator(`[data-node-id="${a.id}"]`)).toHaveCount(1)
  const canvas = await tool<{ nodes: { id: string; text?: string }[]; edges: { label?: string }[] }>(
    'get_canvas'
  )
  expect(canvas.nodes.find((n) => n.id === a.id)?.text).toBe('от агента')
  expect(canvas.edges[0]?.label).toBe('связь')
  await tool('save')
  const onDisk = JSON.parse(await readFile(h.canvasFile, 'utf8')) as { nodes: { text?: string }[] }
  expect(onDisk.nodes.map((n) => n.text)).toContain('от агента')

  await tool('update_node', { id: a.id, text: 'поправил' })
  await tool('run_command', { id: 'edit.undo' })
  const after = await tool<{ text: string }[]>('get_nodes', { ids: [a.id] })
  expect(after[0]?.text).toBe('от агента')
})

test('терминал на холсте получает имя, свой id и токен в окружение', async () => {
  const created = await tool<{ node: { id: string; name: string } }>('create_node', {
    kind: 'terminal',
    command: 'echo "ID=$CNV_NODE_ID NAME=$CNV_TERMINAL_NAME"',
    x: 0,
    y: 300
  })
  const { id, name } = created.node
  expect(name).toMatch(/^\S+ \S+$/)
  await expect(h.page.locator(`[data-node-id="${id}"] [data-testid="terminal-name"]`)).toHaveText(name)
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: name })).text, { timeout: 15000 })
    .toContain(`ID=${id}`)

  // Агент изнутри терминала: тот же сервер, но со своим токеном — whoami знает его ноду.
  await tool('terminal_send', {
    id,
    text: `curl -s -H "Authorization: Bearer $CNV_MCP_TOKEN" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami"}}' "$CNV_MCP_URL"`
  })
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id })).text, { timeout: 15000 })
    .toContain(`\\"nodeId\\": \\"${id}\\"`)
})

test('агент: стартует со своей сессией и MCP-конфигом', async () => {
  const agent = await tool<{ id: string; name: string; sessionId: string; kind: string }>('create_node', {
    kind: 'agent',
    prompt: 'привет',
    x: 0,
    y: 900
  })
  expect(agent.kind).toBe('agent')
  expect(agent.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: agent.id })).text, {
      timeout: 15000
    })
    .toContain(`--session-id ${agent.sessionId} привет`)
  // Первое задание одноразовое: после запуска из документа оно уходит.
  await expect
    .poll(async () => {
      await tool('save')
      return readFile(h.canvasFile, 'utf8')
    })
    .not.toContain('"prompt"')
  const terminals = await tool<{ name: string; kind: string; running: boolean }[]>('list_terminals')
  expect(terminals.find((t) => t.name === agent.name)).toMatchObject({ kind: 'agent', running: true })
})

test('stdio-мост cnv-mcp ходит в тот же сервер', async () => {
  const bin = path.join(userData, 'mcp', 'bin', 'cnv-mcp')
  const env = { ...process.env }
  delete env.CNV_MCP_URL
  delete env.CNV_MCP_TOKEN
  const child = spawn(bin, [], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines: string[] = []
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    lines.push(...parts.filter(Boolean))
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami' } })}\n`
  )
  await expect.poll(() => lines.length, { timeout: 10000 }).toBe(2)
  child.stdin.end()
  const whoami = JSON.parse(lines.find((l) => l.includes('"id":2')) ?? '{}') as {
    result: { content: { text: string }[] }
  }
  expect(JSON.parse(whoami.result.content[0]!.text)).toMatchObject({ app: 'cnv', you: { nodeId: null } })
})

test('скриншот окна', async () => {
  const result = (await rpc('tools/call', { name: 'screenshot', arguments: {} })) as {
    content: { type: string; data?: string }[]
  }
  expect(result.content[0]?.type).toBe('image')
  expect(result.content[0]?.data?.length).toBeGreaterThan(1000)
})

test('веб-страница: имя, чтение, JS и навигация через MCP', async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<title>Стр ${req.url}</title><body><h1 id="h">Привет ${req.url}</h1></body>`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const port = (site.address() as { port: number }).port
  try {
    const web = await tool<{ id: string; name: string }>('create_node', {
      kind: 'web',
      url: `http://127.0.0.1:${port}/a`,
      name: 'Любопытная Варвара',
      x: 1200,
      y: 0
    })
    expect(web.name).toBe('Любопытная Варвара')
    await expect
      .poll(
        async () =>
          (await tool<{ text: string }>('web_read', { id: 'любопытная варвара' }).catch(() => ({ text: '' })))
            .text,
        {
          timeout: 20000
        }
      )
      .toContain('Привет /a')
    const evaluated = await tool<{ result: string }>('web_eval', {
      id: web.id,
      script: 'document.getElementById("h").textContent.toUpperCase()'
    })
    expect(evaluated.result).toBe('ПРИВЕТ /A')
    await tool('web_navigate', { id: web.name, url: `http://127.0.0.1:${port}/b` })
    await expect
      .poll(async () => (await tool<{ title: string }>('web_read', { id: web.id })).title, { timeout: 20000 })
      .toBe('Стр /b')
  } finally {
    site.close()
  }
})

test('роли и связи: агент видит, кто к нему прицеплен', async () => {
  const lead = await tool<{ id: string; name: string; role: string }>('create_node', {
    kind: 'agent',
    role: 'тимлид',
    x: 2000,
    y: 0
  })
  expect(lead.role).toBe('тимлид')
  const dev = await tool<{ id: string; name: string }>('create_node', {
    kind: 'agent',
    role: 'пишет код',
    x: 2000,
    y: 600
  })
  // Системный промпт агента знает его имя и роль.
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: lead.id })).text, {
      timeout: 15000
    })
    .toContain('Твоя роль: тимлид')
  await tool('create_edge', { from: lead.name, to: dev.name, label: 'ставит задачи' })
  const links = await tool<
    { direction: string; label: string; peer: { id: string; role: string; name: string } }[]
  >('connections', { id: dev.name })
  expect(links).toEqual([
    expect.objectContaining({
      direction: 'in',
      label: 'ставит задачи',
      peer: expect.objectContaining({ id: lead.id, name: lead.name, role: 'тимлид' })
    })
  ])
  await expect(h.page.locator(`[data-node-id="${dev.id}"] [data-testid="terminal-role"]`)).toHaveText(
    'пишет код'
  )

  // Роль руками: правый клик → «Роль…».
  await tool('select', { ids: [dev.id] })
  await tool('zoom_to', { ids: [dev.id] })
  await h.page.locator(`[data-node-id="${dev.id}"] [data-testid="terminal-shield"]`).click({ button: 'right' })
  await h.page.locator('[data-command="node.role"]').click()
  await h.page.locator('[data-testid="text-prompt"] input').fill('ревьюер')
  await h.page.keyboard.press('Enter')
  await expect(h.page.locator(`[data-node-id="${dev.id}"] [data-testid="terminal-role"]`)).toHaveText(
    'ревьюер'
  )
  const [updated] = await tool<{ role: string }[]>('get_nodes', { ids: [dev.id] })
  expect(updated?.role).toBe('ревьюер')
})
