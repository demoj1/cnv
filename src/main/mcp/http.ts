import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { RPC_PARSE_ERROR, type Caller, type McpHandler } from './protocol'

/**
 * Streamable HTTP из MCP в самом простом виде: POST с JSON — ответ JSON, без SSE.
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
  close(): Promise<void>
}

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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
