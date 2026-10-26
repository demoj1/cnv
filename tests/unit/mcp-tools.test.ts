import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentMethod, AgentMethods, AgentNode } from '@shared/agent'
import { COMMANDS } from '@shared/commands'
import { McpHandler, type ToolResult } from '../../src/main/mcp/protocol'
import { buildTools, serverInfo, type ToolDeps } from '../../src/main/mcp/tools'

const me: AgentNode = {
  id: 'me',
  kind: 'agent',
  name: 'Хитрый Фома',
  desktop: 1,
  x: 0,
  y: 0,
  width: 1,
  height: 1
}
const other: AgentNode = {
  id: 'o',
  kind: 'terminal',
  name: 'Тихая Нина',
  desktop: 1,
  x: 0,
  y: 0,
  width: 1,
  height: 1
}
const buddy: AgentNode = {
  id: 'b',
  kind: 'agent',
  name: 'Бодрый Олег',
  desktop: 2,
  x: 0,
  y: 0,
  width: 1,
  height: 1
}

const board: AgentNode = {
  id: 'brd',
  kind: 'board',
  desktop: 1,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  board: { title: 'Спринт', lanes: [{ id: 'l1', title: 'Done', cards: [] }] }
}

function setup(): {
  handler: McpHandler
  calls: { method: string; params: unknown }[]
  writes: [string, string][]
  captures: unknown[][]
} {
  const captures: unknown[][] = []
  const calls: { method: string; params: unknown }[] = []
  const writes: [string, string][] = []
  const running = new Set(['me', 'o', 'b'])
  const answers: Partial<{
    [M in AgentMethod]: (p: AgentMethods[M]['params']) => AgentMethods[M]['result']
  }> = {
    getCanvas: () => ({
      nodes: [me, other, buddy, board],
      edges: [{ id: 'e1', fromNode: 'b', toNode: 'me', label: 'ревьюит' }],
      selection: [],
      edgeSelection: [],
      activeNodeId: null,
      viewport: { x: 0, y: 0, width: 1, height: 1, zoom: 1 },
      activeDesktop: 1,
      dirty: false,
      canUndo: false,
      canRedo: false
    }),
    getNodes: ({ ids }) => [me, other, buddy].filter((n) => ids.includes(n.id)),
    findTerminal: ({ ref }) => {
      const hit = [me, other, buddy].find((n) => n.id === ref || n.name === ref)
      if (!hit) throw new Error(`нет терминала ${ref}`)
      return hit
    },
    createNode: ({ init }) => ({ ...other, id: 'new', kind: init.kind === 'web' ? 'web' : 'text' }),
    runCommand: () => ({ ran: true }),
    updateNode: ({ id }) => (id === 'brd' ? board : { ...other, id }),
    findWeb: () => ({ node: { ...other, kind: 'web' }, webContentsId: 7 }),
    webStage: () => ({})
  }
  const deps: ToolDeps = {
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method] as ((p: unknown) => unknown) | undefined
      if (!answer) throw new Error(`не ждали ${method}`)
      return answer(params) as never
    },
    context: () => ({ appVersion: '9', canvasFile: '/c.canvas', workspaceRoot: '/', mcpUrl: 'http://x' }),
    terminals: {
      list: () => [...running].map((nodeId) => ({ nodeId, pid: 1, shell: 'sh', cwd: '/' })),
      isRunning: (id) => running.has(id),
      write: (id, data) => writes.push([id, data])
    },
    importFile: async (abs) => ({ relPath: `attachments/${abs.split('/').pop()}`, source: abs }),
    screenshot: async () => 'AAAA',
    web: {
      evaluate: async () => ({}),
      capture: async (...a) => {
        captures.push(a)
        return 'PNG'
      }
    },
    commands: COMMANDS,
    sleep: async () => {},
    attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-att-'))
  }
  return { handler: new McpHandler(serverInfo(deps), buildTools(deps)), calls, writes, captures }
}

async function call(
  handler: McpHandler,
  name: string,
  args: unknown,
  nodeId: string | null = 'me'
): Promise<ToolResult> {
  const res = (await handler.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { nodeId }
  )) as { result: ToolResult }
  return res.result
}

const json = (r: ToolResult): unknown => JSON.parse((r.content[0] as { text: string }).text)

describe('инструменты MCP', () => {
  it('whoami знает свою ноду и имя', async () => {
    const { handler } = setup()
    expect(json(await call(handler, 'whoami', {}))).toMatchObject({
      app: 'cnv',
      canvasFile: '/c.canvas',
      you: {
        nodeId: 'me',
        name: 'Хитрый Фома',
        insideCanvasTerminal: true,
        connections: [
          {
            edgeId: 'e1',
            direction: 'in',
            label: 'ревьюит',
            peer: { id: 'b', kind: 'agent', name: 'Бодрый Олег', running: true }
          }
        ]
      }
    })
    expect(json(await call(handler, 'whoami', {}, null))).toMatchObject({ you: { nodeId: null } })
  })

  it('новая нода по умолчанию встаёт рядом со своим терминалом', async () => {
    const { handler, calls } = setup()
    await call(handler, 'create_node', { kind: 'text', text: 'привет' })
    expect(calls.at(-1)).toEqual({
      method: 'createNode',
      params: { init: { kind: 'text', text: 'привет' }, place: { near: 'me' } }
    })
  })

  it('агенту имя не задать — только роль; терминалу можно', async () => {
    const { handler, calls } = setup()
    await call(handler, 'create_node', { kind: 'agent', name: 'Android разработчик', role: 'Android' })
    expect(calls.at(-1)?.params).toMatchObject({ init: { kind: 'agent', role: 'Android' } })
    expect((calls.at(-1)?.params as { init: object }).init).not.toHaveProperty('name')
    await call(handler, 'create_node', { kind: 'terminal', name: 'Сборка' })
    expect(calls.at(-1)?.params).toMatchObject({ init: { kind: 'terminal', name: 'Сборка' } })
  })

  it('абсолютный файл копируется во вложения', async () => {
    const { handler, calls } = setup()
    await call(handler, 'create_node', { kind: 'file', file: '/home/me/pic.png' })
    expect(calls.at(-1)?.params).toMatchObject({ init: { kind: 'file', file: 'attachments/pic.png' } })
  })

  it('терминал с командой: команда уходит в его PTY', async () => {
    const { handler, writes } = setup()
    const out = json(await call(handler, 'create_node', { kind: 'terminal', command: 'ls' })) as {
      commandSent?: string
      warning?: string
    }
    // Фейковый create вернул ноду 'new', которой нет среди живых, — ждём таймаут.
    expect(out.warning).toBeTruthy()
    expect(writes).toEqual([])
  })

  it('в себя писать и себя удалять нельзя, к соседу — по имени', async () => {
    const { handler, writes } = setup()
    expect((await call(handler, 'terminal_send', { id: 'Хитрый Фома', text: 'x' })).isError).toBe(true)
    expect((await call(handler, 'delete', { ids: ['me'] })).isError).toBe(true)
    const ok = await call(handler, 'terminal_send', { id: 'Тихая Нина', text: 'ls' })
    expect(ok.isError).toBeUndefined()
    expect(writes).toEqual([['o', 'ls\r']])
  })

  it('terminal_send: клавиши по именам — Esc прерывает агента, Ctrl+C, стрелки', async () => {
    const { handler, writes } = setup()
    await call(handler, 'terminal_send', { id: 'o', keys: ['esc'] })
    await call(handler, 'terminal_send', { id: 'o', text: 'ls', keys: ['ctrl+c', 'up', 'enter'] })
    expect(writes).toEqual([
      ['o', '\x1b'],
      ['o', 'ls\x03\x1b[A\r']
    ])
    expect((await call(handler, 'terminal_send', { id: 'o', keys: ['f13'] })).isError).toBe(true)
    expect((await call(handler, 'terminal_send', { id: 'o' })).isError).toBe(true)
  })

  it('неизвестная команда и кривой цвет — понятные ошибки', async () => {
    const { handler } = setup()
    const bad = await call(handler, 'run_command', { id: 'nope' })
    expect(bad.isError).toBe(true)
    expect((await call(handler, 'run_command', { id: 'edit.undo' })).isError).toBeUndefined()
    const color = await call(handler, 'create_node', { kind: 'text', color: 'красный' })
    expect((color.content[0] as { text: string }).text).toContain('цвет')
  })

  it('снять цвет можно любым способом, как шлют клиенты MCP', async () => {
    for (const value of [null, 'null', 'none', '']) {
      const { handler, calls } = setup()
      const r = await call(handler, 'update_node', { id: 'o', color: value })
      expect(r.isError, String(value)).toBeUndefined()
      expect(calls.at(-1)).toEqual({
        method: 'updateNode',
        params: { id: 'o', patch: { color: null }, restart: true }
      })
    }
  })

  it('связь к соседу по части имени; неоднозначное — с подсказкой', async () => {
    const { handler } = setup()
    const bad = await call(handler, 'connections', { id: 'Нинка' })
    expect((bad.content[0] as { text: string }).text).toContain('Может, ты про «Тихая Нина»')
  })

  it('скриншот приходит картинкой', async () => {
    const { handler } = setup()
    expect((await call(handler, 'screenshot', {})).content[0]).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png'
    })
  })

  it('web_screenshot: ширина и вся высота уходят в снимок, кривая ширина — ошибка', async () => {
    const { handler, captures } = setup()
    expect((await call(handler, 'web_screenshot', { id: 'o', width: 390, full: true })).content[0]).toEqual({
      type: 'image',
      data: 'PNG',
      mimeType: 'image/png'
    })
    await call(handler, 'web_screenshot', { id: 'o' })
    expect(captures).toEqual([
      [7, { width: 390, full: true }],
      [7, {}]
    ])
    expect((await call(handler, 'web_screenshot', { id: 'o', width: 50 })).isError).toBe(true)
  })

  it('board: операция уходит патчем доски, add_card отдаёт id новой карточки', async () => {
    const { handler, calls } = setup()
    const out = json(
      await call(handler, 'board', { id: 'Спринт', op: 'add_card', lane: 'Done', text: 'Релиз', color: '4' })
    ) as { cardId: string }
    expect(out.cardId).toMatch(/^[0-9a-f]{16}$/)
    expect(calls.at(-1)).toEqual({
      method: 'updateNode',
      params: {
        id: 'brd',
        patch: { board: { op: 'add_card', lane: 'Done', text: 'Релиз', id: out.cardId, color: '4' } },
        restart: false
      }
    })
    expect(json(await call(handler, 'board', { id: 'brd', op: 'get' }))).toMatchObject({
      board: { title: 'Спринт' }
    })
    expect((await call(handler, 'board', { id: 'brd', op: 'move_card', card: 'x' })).isError).toBe(true)
    expect((await call(handler, 'board', { id: 'o', op: 'get' })).isError).toBe(true)
  })

  it('инструкции говорят агенту, где он', async () => {
    const { handler } = setup()
    const res = (await handler.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { nodeId: 'me' }
    )) as {
      result: { instructions: string }
    }
    expect(res.result.instructions).toContain('нода me')
    expect(res.result.instructions).toContain('/c.canvas')
  })

  it('agent_send: вставкой, с подписью, потом Enter; не агенту — нельзя', async () => {
    const { handler, writes } = setup()
    const res = await call(handler, 'agent_send', { id: 'Бодрый Олег', message: 'строка 1\nстрока 2' })
    expect(res.isError).toBeUndefined()
    const { messageId } = json(res) as { messageId: string }
    expect(messageId).toMatch(/^m[0-9a-f]{8}$/)
    // В шапке — время отправки: письма приходят пачками, видно, какое свежее.
    expect(writes).toEqual([
      [
        'b',
        expect.stringMatching(
          new RegExp(
            `^\\x1b\\[200~\\[письмо ${messageId} от «Хитрый Фома» \\(id me\\), \\d\\d:\\d\\d:\\d\\d, через cnv MCP; ответить: agent_send id=me reply_to=${messageId}\\]\\nстрока 1\\nстрока 2\\x1b\\[201~$`
          )
        )
      ],
      ['b', '\r']
    ])
    expect((await call(handler, 'agent_send', { id: 'o', message: 'x' })).isError).toBe(true)
    expect((await call(handler, 'agent_send', { id: 'me', message: 'x' })).isError).toBe(true)
  })

  it('письмо с JSON-вложением: файл на диске, адрес в тексте, read_message отдаёт данные', async () => {
    const { handler, writes } = setup()
    const rows = [{ model: 'Pixel 9', price: 59990 }]
    const sent = json(
      await call(handler, 'agent_send', { id: 'Бодрый Олег', message: 'таблица', data: rows })
    ) as {
      messageId: string
      attachments: string[]
    }
    expect(JSON.parse(fs.readFileSync(sent.attachments[0]!, 'utf8'))).toEqual(rows)
    expect(writes[0]![1]).toContain(sent.attachments[0]!)
    // Адресат («Бодрый Олег», id b) читает письмо — данные уже разобраны.
    const read = json(await call(handler, 'read_message', { id: sent.messageId }, 'b')) as { data: unknown }
    expect(read.data).toEqual(rows)
    // Чужому — нельзя.
    expect((await call(handler, 'read_message', { id: sent.messageId }, 'o')).isError).toBe(true)
  })

  it('wait_reply дожидается ответа с reply_to, inbox его помнит', async () => {
    const { handler } = setup()
    const { messageId } = json(await call(handler, 'agent_send', { id: 'b', message: 'как дела?' })) as {
      messageId: string
    }
    const waiting = call(handler, 'wait_reply', { id: messageId, timeout_s: 5 })
    // Бодрый Олег (b) отвечает Хитрому Фоме (me).
    const answer = await call(handler, 'agent_send', { id: 'me', message: 'норм', reply_to: messageId }, 'b')
    expect(answer.isError).toBeUndefined()
    expect(json(await waiting)).toMatchObject({
      reply: { from: 'b', to: 'me', text: 'норм', replyTo: messageId }
    })
    expect(json(await call(handler, 'inbox', {}))).toMatchObject([{ from: 'b', text: 'норм' }])
  })

  it('wait_reply без ответа — timeout, а не вечное ожидание', async () => {
    const { handler } = setup()
    const { messageId } = json(await call(handler, 'agent_send', { id: 'b', message: '?' })) as {
      messageId: string
    }
    expect(json(await call(handler, 'wait_reply', { id: messageId, timeout_s: 1 }))).toEqual({
      timeout: true,
      waitedS: 1
    })
  })
})
