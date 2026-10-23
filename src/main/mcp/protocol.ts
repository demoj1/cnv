/**
 * Минимальный MCP поверх JSON-RPC: initialize, tools/list, tools/call, ping. Ни SSE, ни
 * ресурсов, ни промптов — агенту нужен холст, а не весь протокол. Без electron внутри,
 * чтобы гонять юнитами.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  method: string
  params?: unknown
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } }

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: readonly (string | number)[]
  additionalProperties?: boolean
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

/** Кто зовёт: терминал на холсте (его нода) или внешний клиент без ноды. */
export interface Caller {
  nodeId: string | null
}

export interface McpTool {
  name: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
  run(args: Record<string, unknown>, caller: Caller): Promise<ToolResult | unknown>
}

export interface ServerInfo {
  name: string
  version: string
  /** Текст, который клиент кладёт агенту в контекст сразу при подключении. */
  instructions(caller: Caller): string
}

/** Ошибка аргументов: агенту уходит текст, а не стек. */
export class ToolInputError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
  }
}

function isToolResult(value: unknown): value is ToolResult {
  return isRecord(value) && Array.isArray(value.content)
}

function ok(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export class McpHandler {
  private readonly tools: Map<string, McpTool>

  constructor(
    private readonly info: ServerInfo,
    tools: readonly McpTool[]
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]))
  }

  get toolNames(): string[] {
    return [...this.tools.keys()]
  }

  /** Сообщение или пачка; `null` — ответа не будет (одни уведомления). */
  async handle(message: unknown, caller: Caller): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      if (message.length === 0) return fail(null, RPC_INVALID_REQUEST, 'пустая пачка')
      const out = (await Promise.all(message.map((m) => this.handleOne(m, caller)))).filter(
        (r): r is JsonRpcResponse => r !== null
      )
      return out.length > 0 ? out : null
    }
    return this.handleOne(message, caller)
  }

  private async handleOne(message: unknown, caller: Caller): Promise<JsonRpcResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== '2.0') {
      return fail(null, RPC_INVALID_REQUEST, 'ожидался JSON-RPC 2.0')
    }
    // Ответы клиента на наши запросы нам не нужны — мы ничего не спрашиваем.
    if (typeof message.method !== 'string') return null
    const req = message as unknown as JsonRpcRequest
    const isNotification = req.id === undefined
    const id = req.id ?? null
    const response = await this.dispatch(req.method, req.params, id, caller)
    return isNotification ? null : response
  }

  private async dispatch(
    method: string,
    params: unknown,
    id: JsonRpcId | null,
    caller: Caller
  ): Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize': {
        const requested = isRecord(params) ? params.protocolVersion : undefined
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
          ? (requested as string)
          : LATEST_PROTOCOL_VERSION
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.info.name, version: this.info.version },
          instructions: this.info.instructions(caller)
        })
      }
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        })
      case 'tools/call':
        return ok(id, await this.call(params, caller))
      default:
        if (method.startsWith('notifications/')) return ok(id, {})
        return fail(id, RPC_METHOD_NOT_FOUND, `нет метода ${method}`)
    }
  }

  private async call(params: unknown, caller: Caller): Promise<ToolResult> {
    if (!isRecord(params) || typeof params.name !== 'string') {
      return { content: [{ type: 'text', text: 'tools/call без имени инструмента' }], isError: true }
    }
    const tool = this.tools.get(params.name)
    if (!tool) return { content: [{ type: 'text', text: `нет инструмента ${params.name}` }], isError: true }
    const args = isRecord(params.arguments) ? params.arguments : {}
    try {
      checkArgs(tool.inputSchema, args)
      const value = await tool.run(args, caller)
      return isToolResult(value) ? value : textResult(value)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text }], isError: true }
    }
  }
}

/** Проверка ровно того, что мы сами пишем в схемах: обязательные поля и примитивные типы. */
export function checkArgs(schema: JsonSchema, args: Record<string, unknown>): void {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) throw new ToolInputError(`не хватает аргумента «${key}»`)
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key]
    if (!prop || value === undefined || value === null) continue
    if (!matchesType(prop, value)) throw new ToolInputError(`аргумент «${key}» должен быть ${prop.type}`)
    if (prop.enum && !prop.enum.includes(value as string | number)) {
      throw new ToolInputError(`аргумент «${key}»: одно из ${prop.enum.join(', ')}`)
    }
    if (prop.type === 'array' && prop.items) {
      const items = prop.items
      for (const item of value as unknown[]) {
        if (!matchesType(items, item)) throw new ToolInputError(`элементы «${key}» должны быть ${items.type}`)
      }
    }
  }
}

function matchesType(schema: JsonSchema, value: unknown): boolean {
  switch (schema.type) {
    case undefined:
      return true
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
  }
}
