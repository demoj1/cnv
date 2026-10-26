import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * stdio-мост на живом процессе: cnv на старте занят или ещё не открыл порт — мост ждёт и
 * переподключается, а не отдаёт агенту ошибку (после которой Claude бросает сервер).
 */

let bridgeJs: string
const cleanup: (() => void)[] = []

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-stdio-'))
  bridgeJs = path.join(dir, 'mcp-stdio.cjs')
  buildSync({
    entryPoints: [path.join(__dirname, '../../src/main/mcp-stdio.ts')],
    outfile: bridgeJs,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

/** Свободный порт: занять и сразу отпустить. */
async function freePort(): Promise<number> {
  const server = http.createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  await new Promise((r) => server.close(r))
  return port
}

/** Поддельный cnv: initialize, ping и поток уведомлений. */
function startFakeCnv(port: number): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: unknown; method: string }
      if (msg.id === undefined) return void res.writeHead(202).end()
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'cnv', version: 'test' }
            }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'whoami' }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'ок' }] }
              : {}
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
    })
  })
  server.listen(port, '127.0.0.1')
  cleanup.push(() => {
    server.closeAllConnections()
    server.close()
  })
}

function startBridge(
  port: number,
  env: Record<string, string> = {}
): {
  send(message: unknown): void
  next(
    predicate: (m: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
} {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bridgeJs], {
    env: {
      PATH: process.env.PATH ?? '',
      CNV_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      CNV_MCP_TOKEN: 't',
      ...env
    }
  })
  cleanup.push(() => child.kill())
  const seen: Record<string, unknown>[] = []
  const waiters: (() => void)[] = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    seen.push(JSON.parse(line) as Record<string, unknown>)
    for (const w of waiters.splice(0)) w()
  })
  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    next: (predicate, timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`не дождались: ${JSON.stringify(seen)}`)), timeoutMs)
        const check = (): void => {
          const hit = seen.find(predicate)
          if (hit) {
            clearTimeout(timer)
            resolve(hit)
          } else waiters.push(check)
        }
        check()
      })
  }
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }

describe('stdio-мост cnv', () => {
  it('cnv поднялся позже моста — initialize дожидается его, а не падает', async () => {
    const port = await freePort()
    const bridge = startBridge(port)
    bridge.send(init)
    setTimeout(() => startFakeCnv(port), 1200)
    const reply = await bridge.next((m) => m.id === 1)
    expect(reply).toMatchObject({ result: { serverInfo: { name: 'cnv', version: 'test' } } })
  })

  it('cnv не дождались — пустой сервер, а когда ожил — tools/list_changed и живые инструменты', async () => {
    const port = await freePort()
    const bridge = startBridge(port, { CNV_MCP_WAIT_MS: '300' })
    bridge.send(init)
    expect(await bridge.next((m) => m.id === 1)).toMatchObject({
      result: { serverInfo: { version: 'offline' }, capabilities: { tools: { listChanged: true } } }
    })
    startFakeCnv(port)
    await bridge.next((m) => m.method === 'notifications/tools/list_changed')
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(await bridge.next((m) => m.id === 2)).toMatchObject({ result: { tools: [{ name: 'whoami' }] } })
  })

  it('процесс моста сломан (ECONNABORTED при живом cnv) — мост перерождается и работает дальше', async () => {
    const port = await freePort()
    startFakeCnv(port)
    // Первый процесс «сломан»: каждое его подключение падает, как в живом баге.
    const bridge = startBridge(port, {
      CNV_MCP_FAKE_ABORT: '0',
      CNV_MCP_WAIT_MS: '300',
      CNV_MCP_RETRY_MS: '300'
    })
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami' } })
    expect(await bridge.next((m) => m.id === 1)).toMatchObject({ error: { message: /перезапускается/ } })
    await bridge.next((m) => m.method === 'notifications/tools/list_changed')
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami' } })
    expect(await bridge.next((m) => m.id === 2)).toMatchObject({ result: { content: [{ text: 'ок' }] } })
  })
})
