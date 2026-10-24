import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cameraState, launchApp, type Harness } from './helpers'

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
      settings: { agents: { commands: { claude: 'echo' } }, terminal: { shell: '/bin/sh' } },
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
  // Сессию начинает сам агент, а cnv записывает её id в ноду — у Claude она известна сразу.
  let sessionId = ''
  await expect
    .poll(
      async () => {
        const [node] = await tool<{ sessionId?: string; agent?: string }[]>('get_nodes', { ids: [agent.id] })
        sessionId = node?.sessionId ?? ''
        return { sessionId, agent: node?.agent }
      },
      { timeout: 15000 }
    )
    .toEqual({ sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), agent: 'claude' })
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: agent.id })).text, {
      timeout: 15000
    })
    .toContain(`--session-id ${sessionId} привет`)
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
    const cut = await tool<{ result: string; truncated: boolean }>('web_eval', {
      id: web.id,
      script: '"x".repeat(5000)',
      max_chars: 100
    })
    expect(cut).toMatchObject({ truncated: true, totalChars: 5000 })
    const out = path.join(userData, 'eval-out.json')
    const scriptFile = path.join(userData, 'eval.js')
    await writeFile(scriptFile, '({ title: document.title, n: 2 + 2 })')
    expect(await tool('web_eval', { id: web.id, script_file: scriptFile, out_file: out })).toMatchObject({
      savedTo: out
    })
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ n: 4 })
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
  await h.page
    .locator(`[data-node-id="${dev.id}"] [data-testid="terminal-shield"]`)
    .click({ button: 'right' })
  await h.page.locator('[data-command="node.role"]').click()
  await h.page.locator('[data-testid="text-prompt"] input').fill('ревьюер')
  await h.page.keyboard.press('Enter')
  await expect(h.page.locator(`[data-node-id="${dev.id}"] [data-testid="terminal-role"]`)).toHaveText(
    'ревьюер'
  )
  const [updated] = await tool<{ role: string }[]>('get_nodes', { ids: [dev.id] })
  expect(updated?.role).toBe('ревьюер')
  // Агент уже работает — новую роль ему сообщают прямо в чат.
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: dev.id })).text, {
      timeout: 10000
    })
    .toContain('Твоя роль теперь: ревьюер.')
  // И переименование — тоже.
  await tool('update_node', { id: dev.id, name: 'Новый Ревьюер' })
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: dev.id })).text, {
      timeout: 10000
    })
    .toContain('теперь ты «Новый Ревьюер»')
})

test('рабочие столы: Alt+цифра, агенты живут на всех столах, MCP видит всё', async () => {
  const before = await tool<{ activeDesktop: number }>('list_desktops')
  expect(before.activeDesktop).toBe(1)

  // Агент-терминал на третьем столе: создаётся там, работает, пока человек на первом.
  const far = await tool<{ node: { id: string; desktop: number; name: string } }>('create_node', {
    kind: 'terminal',
    desktop: 3,
    command: 'echo FAR_ALIVE'
  })
  expect(far.node.desktop).toBe(3)
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: far.node.id })).text, {
      timeout: 15000
    })
    .toContain('FAR_ALIVE')

  // Человек жмёт Alt+3 — экран переезжает на третий стол.
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 5, y: 5 } })
  await h.page.keyboard.press('Alt+3')
  await expect(h.page.locator('.desktops__item--current')).toHaveText('3')
  expect((await tool<{ activeDesktop: number }>('list_desktops')).activeDesktop).toBe(3)
  await expect(h.page.locator(`[data-node-id="${far.node.id}"]`)).toBeInViewport()

  // Alt+0 — десятый, агент через MCP возвращает на первый.
  await h.page.keyboard.press('Alt+0')
  await expect(h.page.locator('.desktops__item--current')).toHaveText('0')
  await tool('switch_desktop', { desktop: 1 })
  await expect(h.page.locator('.desktops__item--current')).toHaveText('1')

  // Перенос по имени: процесс не перезапускается — тот же вывод на экране.
  await tool('move_to_desktop', { ids: [far.node.name], desktop: 2 })
  const [moved] = await tool<{ desktop: number }[]>('get_nodes', { ids: [far.node.id] })
  expect(moved?.desktop).toBe(2)
  expect((await tool<{ text: string }>('terminal_read', { id: far.node.id })).text).toContain('FAR_ALIVE')

  const only2 = await tool<{ nodes: { id: string }[] }>('get_canvas', { desktop: 2 })
  expect(only2.nodes.map((n) => n.id)).toEqual([far.node.id])
})

test('batch: mind map одним вызовом и одной записью в истории; ошибка — не применяется ничего', async () => {
  const before = (await tool<{ nodes: unknown[]; edges: unknown[] }>('get_canvas', { max_text: 0 })).nodes
    .length
  const res = await tool<{ results: { id: string }[]; refs: Record<string, string> }>('batch', {
    ops: [
      { op: 'create_node', ref: 'root', kind: 'text', text: 'BATCH_ROOT', x: 5000, y: 5000, color: '5' },
      { op: 'create_node', ref: 'a', kind: 'text', text: 'BATCH_A', near: '$root' },
      { op: 'create_node', ref: 'b', kind: 'text', text: 'BATCH_B', near: '$root' },
      { op: 'create_edge', from: '$root', to: '$a', label: 'ветка' },
      { op: 'create_edge', from: '$root', to: '$b' },
      { op: 'update_node', id: '$b', color: '1' }
    ]
  })
  expect(Object.keys(res.refs)).toEqual(['root', 'a', 'b'])
  expect(res.results).toHaveLength(6)
  const found = await tool<{ total: number; nodes: { id: string; color?: string }[] }>('find_nodes', {
    text: 'BATCH_'
  })
  expect(found.total).toBe(3)
  expect(found.nodes.find((n) => n.id === res.refs.b)?.color).toBe('1')
  const links = await tool<unknown[]>('connections', { id: res.refs.root })
  expect(links).toHaveLength(2)

  // Одна отмена убирает весь пакет.
  await tool('run_command', { id: 'edit.undo' })
  expect((await tool<{ total: number }>('find_nodes', { text: 'BATCH_' })).total).toBe(0)

  // Третья операция ссылается в никуда — не создаётся ничего, и ошибка говорит, где.
  await expect(
    tool('batch', {
      ops: [
        { op: 'create_node', ref: 'x', kind: 'text', text: 'BATCH_X' },
        { op: 'create_node', kind: 'text', text: 'BATCH_Y' },
        { op: 'create_edge', from: '$x', to: '$nope' }
      ]
    })
  ).rejects.toThrow(/операция 3.*пакет не применён/)
  expect((await tool<{ nodes: unknown[] }>('get_canvas', { max_text: 0 })).nodes.length).toBe(before)
})

test('web_fetch: с куками сессии веб-страниц, JSON — разобранным, HTML — текстом, POST с JSON-телом', async () => {
  const site = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      if (req.url === '/api') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({ cookie: req.headers.cookie ?? null, method: req.method, body: body || null })
        )
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<html><script>x()</script><body><h1>Каталог</h1><p>Pixel&nbsp;9</p></body></html>')
      }
    })
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`
  try {
    await h.app.evaluate(
      ({ session }, url) =>
        session.fromPartition('persist:web').cookies.set({ url, name: 'sid', value: 'LOGGED_IN' }),
      base
    )
    const get = await tool<{ status: number; json: { cookie: string; method: string } }>('web_fetch', {
      url: `${base}/api`
    })
    expect(get.status).toBe(200)
    expect(get.json).toMatchObject({ cookie: 'sid=LOGGED_IN', method: 'GET' })

    const post = await tool<{ json: { method: string; body: string } }>('web_fetch', {
      url: `${base}/api`,
      body: { q: 'телефоны' }
    })
    expect(post.json.method).toBe('POST')
    expect(JSON.parse(post.json.body)).toEqual({ q: 'телефоны' })

    const page = await tool<{ text: string }>('web_fetch', { url: `${base}/page` })
    expect(page.text).toBe('Каталог\nPixel 9')
  } finally {
    site.close()
  }
})

test('журнал: кто удалил — видно, удалённое возвращается restore, changed_since даёт разницу', async () => {
  const t0 = Date.now()
  const card = await tool<{ id: string }>('create_node', {
    kind: 'text',
    text: 'JOURNAL_CARD',
    x: 8000,
    y: 0
  })
  const peer = await tool<{ id: string }>('create_node', {
    kind: 'text',
    text: 'JOURNAL_PEER',
    x: 8400,
    y: 0
  })
  await tool('create_edge', { from: card.id, to: peer.id })
  await tool('delete', { ids: [card.id] })

  const log = await tool<{ actor: string; nodes: { removed: string[] } }[]>('history', { ids: [card.id] })
  const removal = log.find((e) => e.nodes.removed.includes(card.id))
  expect(removal?.actor).toBe('внешний клиент MCP')

  const diff = await tool<{ nodes: { added: string[]; removed: string[] } }>('changed_since', { since: t0 })
  // Карточка появилась и пропала — в итоге её нет; сосед — добавлен.
  expect(diff.nodes.added).toContain(peer.id)
  expect(diff.nodes.added).not.toContain(card.id)

  const back = await tool<{ restored: string[]; edges: string[] }>('restore', { ids: [card.id] })
  expect(back.restored).toEqual([card.id])
  expect(back.edges).toHaveLength(1)
  expect((await tool<{ total: number }>('find_nodes', { text: 'JOURNAL_CARD' })).total).toBe(1)
  expect(await tool<unknown[]>('connections', { id: card.id })).toHaveLength(1)
})

test('layout tree + check_overlaps + get_subtree + get_edges: mind map без ручных координат', async () => {
  // Все ноды кучей в одной точке — заведомо налезают.
  const res = await tool<{ refs: Record<string, string> }>('batch', {
    ops: [
      { op: 'create_node', ref: 'root', kind: 'text', text: 'MAP_ROOT', x: 12000, y: 0 },
      ...['a', 'b', 'c'].map((r) => ({
        op: 'create_node',
        ref: r,
        kind: 'text',
        text: `MAP_${r}`,
        x: 12000,
        y: 0
      })),
      { op: 'create_node', ref: 'a1', kind: 'text', text: 'MAP_a1', x: 12000, y: 0 },
      { op: 'create_edge', from: '$root', to: '$a' },
      { op: 'create_edge', from: '$root', to: '$b' },
      { op: 'create_edge', from: '$root', to: '$c' },
      { op: 'create_edge', from: '$a', to: '$a1' }
    ]
  })
  const ids = Object.values(res.refs)
  const before = await tool<{ overlaps: unknown[] }>('check_overlaps', { ids })
  expect(before.overlaps.length).toBeGreaterThan(0)

  await tool('layout', { ids, mode: 'tree', root: res.refs.root, x: 12000, y: 0 })
  const after = await tool<{ overlaps: unknown[]; edgesThroughNodes: unknown[] }>('check_overlaps', { ids })
  expect(after).toEqual({ overlaps: [], edgesThroughNodes: [] })

  const tree = await tool<{ nodes: { id: string; depth: number }[]; edges: unknown[] }>('get_subtree', {
    id: res.refs.root
  })
  expect(tree.nodes).toHaveLength(5)
  expect(tree.nodes.find((n) => n.id === res.refs.a1)?.depth).toBe(2)
  expect(tree.edges).toHaveLength(4)
  expect(await tool<unknown[]>('get_edges', { ids: [res.refs.a] })).toHaveLength(2)
  // Раскладка — одна запись в истории.
  await tool('run_command', { id: 'edit.undo' })
  expect((await tool<{ overlaps: unknown[] }>('check_overlaps', { ids })).overlaps.length).toBeGreaterThan(0)
})

test('update_node session_id перепривязывает агента к другой сессии и перезапускает его', async () => {
  const agent = await tool<{ id: string }>('create_node', { kind: 'agent', x: 15000, y: 0 })
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: agent.id })).text, {
      timeout: 15000
    })
    .toContain('--session-id')
  // Случайный id: такой сессии на диске точно нет — Claude начнёт её с этим id.
  const wanted = randomUUID()
  await tool('update_node', { id: agent.id, session_id: wanted })
  await expect
    .poll(async () => (await tool<{ text: string }>('terminal_read', { id: agent.id })).text, {
      timeout: 15000
    })
    .toContain(`--session-id ${wanted}`)
  const [node] = await tool<{ sessionId: string }[]>('get_nodes', { ids: [agent.id] })
  expect(node!.sessionId).toBe(wanted)
  const listed = await tool<{ agent: string; current: string }>('list_agent_sessions', { id: agent.id })
  expect(listed).toMatchObject({ agent: 'claude', current: wanted })
})

test('файл снаружи workspace: компактная плашка, копия следует за оригиналом', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), 'cnv-outside-'))
  const original = path.join(outside, 'расчёт.csv')
  await writeFile(original, 'a,b\n1,2\n')
  const node = await tool<{ id: string; file: string; source: string; width: number; height: number }>(
    'create_node',
    { kind: 'file', file: original, x: 20000, y: 0 }
  )
  expect(node.source).toBe(original)
  expect(node.file).toMatch(/^attachments\//)
  expect({ w: node.width, h: node.height }).toEqual({ w: 260, h: 64 })
  const copy = path.join(path.dirname(h.canvasFile), node.file)
  expect(await readFile(copy, 'utf8')).toBe('a,b\n1,2\n')

  // Правим оригинал — копия догоняет (сверка при возврате в окно).
  await new Promise((r) => setTimeout(r, 20))
  await writeFile(original, 'a,b\n1,2\n3,4\n')
  await h.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => readFile(copy, 'utf8'), { timeout: 10000 }).toBe('a,b\n1,2\n3,4\n')
  await rm(outside, { recursive: true, force: true })
})

test('хелперы web_eval переживают навигацию', async () => {
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html><head><title>Стр ${req.url}</title></head><body><li>раз</li><li>два</li></body></html>`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`
  try {
    const page = await tool<{ id: string }>('create_node', { kind: 'web', url: `${base}/a`, x: 0, y: 3000 })
    await tool('zoom_to', { ids: [page.id] })
    await expect
      .poll(
        async () =>
          (await tool<{ title: string }>('web_read', { id: page.id }).catch(() => ({ title: '' }))).title,
        {
          timeout: 20000
        }
      )
      .toBe('Стр /a')
    await tool('web_helpers', {
      set: { items: '() => [...document.querySelectorAll("li")].map((e) => e.textContent)' }
    })
    expect(
      (await tool<{ result: string[] }>('web_eval', { id: page.id, script: 'cnv.items()' })).result
    ).toEqual(['раз', 'два'])
    await tool('web_navigate', { id: page.id, url: `${base}/b` })
    await expect
      .poll(async () => (await tool<{ title: string }>('web_read', { id: page.id })).title, {
        timeout: 20000
      })
      .toBe('Стр /b')
    // После навигации window.cnv пуст, но хелпер подставляется заново.
    expect(
      (await tool<{ result: number }>('web_eval', { id: page.id, script: 'cnv.items().length' })).result
    ).toBe(2)
    // Фоновых вкладок без ноды нет: человек видит всё, что открывают агенты.
    const { tools } = (await rpc('tools/list', {})) as { tools: { name: string }[] }
    expect(tools.map((t) => t.name)).not.toContain('tab_open')
  } finally {
    site.close()
  }
})

test('screenshot нод на другом столе — без сдвига камеры человеку, в своём масштабе', async () => {
  const far = await tool<{ refs: Record<string, string> }>('batch', {
    ops: [
      {
        op: 'create_node',
        ref: 'a',
        kind: 'text',
        text: '# SNAP_A',
        x: 700000,
        y: 0,
        width: 300,
        height: 150,
        color: '4'
      },
      {
        op: 'create_node',
        ref: 'b',
        kind: 'text',
        text: 'SNAP_B',
        x: 1100000 - 400000 + 400,
        y: 0,
        width: 300,
        height: 150
      },
      { op: 'create_edge', from: '$a', to: '$b' }
    ]
  })
  const before = await cameraState(h.page)
  const shot = (await rpc('tools/call', {
    name: 'screenshot',
    arguments: { ids: [far.refs.a, far.refs.b], scale: 1 }
  })) as { content: { type: string; data: string }[]; isError?: boolean }
  expect(shot.isError).toBeUndefined()
  expect(shot.content[0]?.type).toBe('image')
  const png = Buffer.from(shot.content[0]!.data, 'base64')
  // Ширина/высота из заголовка PNG: две карточки + зазор + поля по 24.
  expect(png.readUInt32BE(16)).toBe(700 + 48)
  expect(png.readUInt32BE(20)).toBe(150 + 48)
  // Человеку камеру не трогали.
  expect(await cameraState(h.page)).toEqual(before)
})
