import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RPC_PARSE_ERROR, type Caller, type McpHandler } from './protocol'

/**
 * Streamable HTTP из MCP в самом простом виде: POST с JSON — ответ JSON. GET — поток SSE
 * от сервера к агенту: по нему уходят письма каналом (MCP channels Claude Code), мимо
 * поля ввода в его терминале.
 * Слушаем только loopback, пускаем по bearer-токену: токен у каждого терминала свой,
 * по нему сервер и понимает, из какой карточки пришёл агент.
 */

export const MCP_PATH = '/mcp'
const MAX_BODY = 16 * 1024 * 1024

export interface McpHttpOptions {
  handler: McpHandler
  /** Токен → кто зовёт; `null` — чужой. */
  authenticate(token: string): Caller | null
  port?: number
}

export interface McpHttpServer {
  url: string
  port: number
  /** Уведомление агенту ноды по его SSE-потокам; сколько потоков его получили. */
  push(nodeId: string, message: unknown): number
  /** Агент ноды держит открытый поток — ему можно слать уведомления. */
  hasStream(nodeId: string): boolean
  close(): Promise<void>
}

/** Поток молчит дольше — прокси и сам клиент могут счесть его мёртвым. */
const KEEPALIVE_MS = 20_000

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('слишком большой запрос'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function bearer(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

export async function startMcpHttp(options: McpHttpOptions): Promise<McpHttpServer> {
  const streams = new Map<string, Set<http.ServerResponse>>()
  const keepalive = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n')
  }, KEEPALIVE_MS)
  keepalive.unref()

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== MCP_PATH) return send(res, 404, { error: 'not found' })
      // Страница из браузера сюда ходить не должна: защита от DNS rebinding.
      if (req.headers.origin) return send(res, 403, { error: 'origin запрещён' })
      const token = bearer(req.headers.authorization)
      const caller = token ? options.authenticate(token) : null
      if (!caller) return send(res, 401, { error: 'нужен Authorization: Bearer <CNV_MCP_TOKEN>' })

      if (req.method === 'DELETE') return send(res, 200)
      if (req.method === 'GET') {
        if (!String(req.headers.accept ?? '').includes('text/event-stream'))
          return send(res, 405, { error: 'GET — только text/event-stream' })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.write(': open\n\n')
        // Поток внешнего клиента без ноды держим, но писать в него нечего.
        const key = caller.nodeId ?? ''
        const set = streams.get(key) ?? new Set()
        set.add(res)
        streams.set(key, set)
        req.on('close', () => {
          set.delete(res)
          if (set.size === 0 && streams.get(key) === set) streams.delete(key)
        })
        return
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'только POST' })

      let message: unknown
      try {
        message = JSON.parse(await readBody(req))
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: text } })
      }
      const response = await options.handler.handle(message, caller)
      if (response === null) return send(res, 202)
      send(res, 200, response)
    })().catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    port,
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    push(nodeId, message) {
      const set = streams.get(nodeId)
      if (!set) return 0
      const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`
      for (const res of set) res.write(frame)
      return set.size
    },
    hasStream: (nodeId) => (streams.get(nodeId)?.size ?? 0) > 0,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(keepalive)
        for (const set of streams.values()) for (const res of set) res.end()
        streams.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
