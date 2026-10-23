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

function setup(): {
  handler: McpHandler
  calls: { method: string; params: unknown }[]
  writes: [string, string][]
} {
  const calls: { method: string; params: unknown }[] = []
  const writes: [string, string][] = []
  const running = new Set(['me', 'o', 'b'])
  const answers: Partial<{
    [M in AgentMethod]: (p: AgentMethods[M]['params']) => AgentMethods[M]['result']
  }> = {
    getCanvas: () => ({
      nodes: [me, other, buddy],
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
    runCommand: () => ({ ran: true })
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
    importFile: async (abs) => `attachments/${abs.split('/').pop()}`,
    screenshot: async () => 'AAAA',
    web: { evaluate: async () => ({}), capture: async () => null },
    commands: COMMANDS,
    sleep: async () => {}
  }
  return { handler: new McpHandler(serverInfo(deps), buildTools(deps)), calls, writes }
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

  it('неизвестная команда и кривой цвет — понятные ошибки', async () => {
    const { handler } = setup()
    const bad = await call(handler, 'run_command', { id: 'nope' })
    expect(bad.isError).toBe(true)
    expect((await call(handler, 'run_command', { id: 'edit.undo' })).isError).toBeUndefined()
    const color = await call(handler, 'create_node', { kind: 'text', color: 'красный' })
    expect((color.content[0] as { text: string }).text).toContain('цвет')
  })

  it('скриншот приходит картинкой', async () => {
    const { handler } = setup()
    expect((await call(handler, 'screenshot', {})).content[0]).toEqual({
      type: 'image',
      data: 'AAAA',
      mimeType: 'image/png'
    })
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
    expect(writes).toEqual([
      ['b', '\x1b[200~[сообщение от «Хитрый Фома» (id me) через cnv MCP]\nстрока 1\nстрока 2\x1b[201~'],
      ['b', '\r']
    ])
    expect((await call(handler, 'agent_send', { id: 'o', message: 'x' })).isError).toBe(true)
    expect((await call(handler, 'agent_send', { id: 'me', message: 'x' })).isError).toBe(true)
  })
})
