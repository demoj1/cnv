import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { McpHandler, checkArgs, type McpTool } from '../../src/main/mcp/protocol'
import { startMcpHttp, type McpHttpServer } from '../../src/main/mcp/http'
import { TokenRegistry } from '../../src/main/mcp/tokens'

const echo: McpTool = {
  name: 'echo',
  description: 'эхо',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async (args, caller) => ({ text: args.text, nodeId: caller.nodeId })
}
const boom: McpTool = {
  name: 'boom',
  description: 'падает',
  inputSchema: { type: 'object', properties: {} },
  run: async () => {
    throw new Error('сломалось')
  }
}

const handler = new McpHandler(
  { name: 'cnv', version: '0', instructions: (c) => `нода ${c.nodeId ?? 'нет'}` },
  [echo, boom]
)
const tokens = new TokenRegistry()
let server: McpHttpServer

beforeAll(async () => {
  server = await startMcpHttp({ handler, authenticate: (t) => tokens.resolve(t) })
})
afterAll(() => server.close())

async function rpc(
  token: string | null,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  })
}

describe('MCP по HTTP', () => {
  it('без токена — 401, с чужим Origin — 403', async () => {
    expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
    expect((await rpc('wrong-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
    const evil = await rpc(
      tokens.appToken,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { origin: 'https://evil' }
    )
    expect(evil.status).toBe(403)
  })

  it('initialize рассказывает агенту, из какой он ноды', async () => {
    const token = tokens.issue('node-42')
    const res = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    })
    const body = (await res.json()) as { result: { protocolVersion: string; instructions: string } }
    expect(body.result.protocolVersion).toBe('2025-03-26')
    expect(body.result.instructions).toBe('нода node-42')
  })

  it('уведомление — 202 без тела', async () => {
    const res = await rpc(tokens.appToken, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
  })

  it('tools/list и tools/call знают вызывающего', async () => {
    const token = tokens.issue('n1')
    const list = (await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: { name: string }[] }
    }
    expect(list.result.tools.map((t) => t.name)).toEqual(['echo', 'boom'])
    const call = (await (
      await rpc(token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } }
      })
    ).json()) as { result: { content: { text: string }[] } }
    expect(JSON.parse(call.result.content[0]!.text)).toEqual({ text: 'hi', nodeId: 'n1' })
  })

  it('отозванный токен больше не пускает', async () => {
    const token = tokens.issue('n2')
    tokens.revoke('n2')
    expect((await rpc(token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401)
  })

  it('ошибка инструмента — isError, а не падение протокола', async () => {
    const res = await rpc(tokens.appToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'boom' }
    })
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]!.text).toBe('сломалось')
  })

  it('пачка запросов отвечается пачкой', async () => {
    const res = await rpc(tokens.appToken, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'nope' }
    ])
    const body = (await res.json()) as { id: number; error?: { code: number } }[]
    expect(body).toHaveLength(2)
    expect(body[1]!.error?.code).toBe(-32601)
  })
})

describe('проверка аргументов', () => {
  it('ловит пропуски, типы и enum', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        a: { type: 'string' as const },
        n: { type: 'number' as const },
        k: { type: 'string' as const, enum: ['x', 'y'] },
        list: { type: 'array' as const, items: { type: 'string' as const } }
      },
      required: ['a']
    }
    expect(() => checkArgs(schema, {})).toThrow('«a»')
    expect(() => checkArgs(schema, { a: 1 })).toThrow('string')
    expect(() => checkArgs(schema, { a: 'ok', n: 'x' })).toThrow('number')
    expect(() => checkArgs(schema, { a: 'ok', k: 'z' })).toThrow('x, y')
    expect(() => checkArgs(schema, { a: 'ok', list: [1] })).toThrow('элементы')
    expect(() => checkArgs(schema, { a: 'ok', n: 1, k: 'x', list: ['q'] })).not.toThrow()
  })
})
