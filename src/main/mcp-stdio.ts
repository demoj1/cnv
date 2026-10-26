/**
 * `cnv-mcp`: stdio-мост к MCP-серверу cnv для агентов, которые умеют только stdio
 * (Claude Code, Codex, Gemini — все умеют). Запускается электроном в режиме node:
 * `ELECTRON_RUN_AS_NODE=1 electron mcp-stdio.js`. Адрес и токен берёт из окружения
 * терминала cnv (`CNV_MCP_URL`, `CNV_MCP_TOKEN`), а снаружи cnv — из файла discovery
 * (`--discovery <file>`), с общим токеном и без своей ноды.
 *
 * Здесь нет электрона и зависимостей: только node:http и построчный JSON-RPC.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import readline from 'node:readline'

interface Target {
  url: string
  token: string
}

interface Discovery {
  url?: unknown
  token?: unknown
}

function discoveryPath(argv: readonly string[]): string | null {
  const i = argv.indexOf('--discovery')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

function resolveTarget(): Target | null {
  const url = process.env.CNV_MCP_URL
  const token = process.env.CNV_MCP_TOKEN
  if (url && token) return { url, token }
  const file = discoveryPath(process.argv)
  if (!file) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Discovery
    if (typeof raw.url === 'string' && typeof raw.token === 'string')
      return { url: raw.url, token: raw.token }
  } catch {
    // Файла нет — cnv не запущен.
  }
  return null
}

function post(target: Target, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    // Для тестов: этот процесс «сломан» — каждое подключение падает, как в живом баге.
    if (process.env.CNV_MCP_FAKE_ABORT === String(GENERATION))
      return reject(Object.assign(new Error('connect ECONNABORTED'), { code: 'ECONNABORTED' }))
    const req = http.request(
      target.url,
      {
        method: 'POST',
        // Свой агент, а не глобальный: с NODE_USE_ENV_PROXY глобальный пойдёт через прокси даже к loopback.
        agent: new http.Agent(),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${target.token}`,
          'content-length': Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        )
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Поток уведомлений сервера (GET, SSE) — письма каналом приходят по нему. Держим его,
 * пока жив агент: оборвался (cnv перезапустили) — переподключаемся.
 */
let listening = false
/** Поток уведомлений сейчас; при передаче дел новому мосту его закрываем. */
let stream: http.ClientRequest | null = null
function listen(): void {
  if (listening) return
  listening = true
  const connect = (): void => {
    if (handedOver) return
    const target = resolveTarget()
    if (!target) return void setTimeout(connect, 3000)
    const req = http.request(
      target.url,
      {
        method: 'GET',
        agent: new http.Agent(),
        headers: { accept: 'text/event-stream', authorization: `Bearer ${target.token}` }
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return void setTimeout(connect, 3000)
        }
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buffer += chunk
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n')
            if (data) process.stdout.write(`${data}\n`)
          }
        })
        res.on('end', () => setTimeout(connect, 1000))
        res.on('error', () => setTimeout(connect, 1000))
      }
    )
    req.on('error', () => setTimeout(connect, 3000))
    req.end()
    stream = req
  }
  connect()
}

/** Ошибки связи, при которых запрос до сервера не дошёл: cnv ещё поднимается или перезапущен. */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL'
])
/** А эти — оборвался уже отправленный запрос: повторять можно только безопасные методы. */
const DROP_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT'])
const errorCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : ''

/** Методы без побочных эффектов: их можно повторить, даже если первый запрос оборвался. */
const SAFE_METHODS = new Set(['initialize', 'tools/list', 'ping', 'resources/list', 'prompts/list'])

/** Сколько ждать cnv на старте: Claude сам ждёт MCP-сервер около 30 с. */
const STARTUP_WAIT_MS = Number(process.env.CNV_MCP_WAIT_MS ?? 25_000)
/** Сколько повторять обычный запрос, если cnv перезапускается. */
const RETRY_WAIT_MS = Number(process.env.CNV_MCP_RETRY_MS ?? 10_000)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * POST с повтором: cnv может быть занят стартом (ECONNABORTED), ещё не открыть порт или
 * сменить адрес и токен после перезапуска — поэтому цель перечитываем на каждой попытке.
 * `null` — так и не достучались до `deadline`.
 */
async function postRetry(
  line: string,
  safe: boolean,
  waitMs: number
): Promise<{ reply: { status: number; text: string } } | { reply: null; lastError: string }> {
  const deadline = Date.now() + waitMs
  let pause = 100
  let lastError = 'нет адреса cnv'
  for (;;) {
    const target = resolveTarget()
    if (target) {
      try {
        return { reply: await post(target, line) }
      } catch (error) {
        const code = errorCode(error)
        if (!CONNECT_ERRORS.has(code) && !(safe && DROP_ERRORS.has(code))) throw error
        lastError = code
      }
    }
    if (Date.now() + pause > deadline) return { reply: null, lastError }
    await sleep(pause)
    pause = Math.min(pause * 2, 2000)
  }
}

/** Какой это по счёту мост у агента: 0 — первый, дальше — перерождения. */
const GENERATION = Number(process.env.CNV_MCP_GENERATION ?? 0)
/** Больше не перерождаемся: значит, дело не в процессе. */
const MAX_GENERATION = 5
let handedOver = false

/**
 * Процесс сломан: cnv жив, а каждое новое подключение падает с ECONNABORTED. Так бывает с
 * Electron в режиме node, запущенным пачкой, и лечится только новым процессом. Запускаем
 * свежий мост на тех же stdin/stdout, а этот остаётся ждать его — клиент видит тот же
 * процесс и ничего не замечает. Свежий сразу просит перечитать инструменты.
 */
function respawn(): boolean {
  if (handedOver || GENERATION >= MAX_GENERATION) return handedOver
  handedOver = true
  rl.close()
  stream?.destroy()
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, CNV_MCP_GENERATION: String(GENERATION + 1) }
  })
  process.stdin.destroy()
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', () => process.exit(1))
  return true
}

/**
 * cnv не ответил на старте: агенту уже отдали «пустой» сервер. Пробуем дальше в фоне и,
 * как только cnv ожил, просим клиента перечитать инструменты и открываем поток писем.
 */
let recovering = false
function recover(): void {
  if (recovering) return
  recovering = true
  const probe = async (): Promise<void> => {
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 'cnv-probe', method: 'ping' })
    if (handedOver) return
    const result = await postRetry(ping, true, 3000).catch(() => null)
    if (result && !result.reply && result.lastError === 'ECONNABORTED' && respawn()) return
    if (!result?.reply || result.reply.status !== 200) return void setTimeout(() => void probe(), 3000)
    recovering = false
    online = true
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    listen()
  }
  void probe()
}

/** Сервер ответил хоть раз: дальше обрывы — это перезапуск cnv, а не старт. */
let online = false

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const idOf = (message: unknown): string | number | null | undefined =>
  message && typeof message === 'object' ? (message as { id?: string | number | null }).id : undefined

/** cnv не запущен: честно подключаемся, но без инструментов и с объяснением, почему. */
function offline(message: unknown, reason = 'cnv не запущен'): void {
  const id = idOf(message)
  if (id === undefined) return
  const method = (message as { method?: unknown }).method
  if (method === 'initialize') {
    const requested = (message as { params?: { protocolVersion?: unknown } }).params?.protocolVersion
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof requested === 'string' ? requested : '2025-06-18',
        // listChanged — чтобы, когда cnv оживёт, клиент перечитал инструменты сам.
        capabilities: { tools: { listChanged: true }, experimental: { 'claude/channel': {} } },
        serverInfo: { name: 'cnv', version: 'offline' },
        instructions:
          'Приложение cnv сейчас недоступно — инструментов холста пока нет. Мост ждёт его и подключится сам: инструменты появятся без перезапуска.'
      }
    })
  } else if (method === 'tools/list') {
    write({ jsonrpc: '2.0', id, result: { tools: [] } })
  } else if (method === 'ping') {
    write({ jsonrpc: '2.0', id, result: {} })
  } else {
    write({ jsonrpc: '2.0', id, error: { code: -32000, message: reason } })
  }
}

async function forward(line: string): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'не JSON' } })
    return
  }
  const method = (message as { method?: unknown }).method
  const safe = typeof method === 'string' && SAFE_METHODS.has(method)
  try {
    // Цель ищем на каждой попытке: cnv могли перезапустить, пока агент жив.
    const result = await postRetry(
      line,
      safe,
      method === 'initialize' && !online ? STARTUP_WAIT_MS : RETRY_WAIT_MS
    )
    const reply = result.reply
    if (!reply) {
      const lastError = 'lastError' in result ? result.lastError : ''
      if (lastError === 'ECONNABORTED' && respawn()) {
        offline(message, 'мост cnv перезапускается — повтори вызов через пару секунд')
        return
      }
      offline(message, `cnv не отвечает (${lastError}) — мост ждёт его и подключится сам`)
      if (method === 'initialize' || method === 'tools/list') recover()
      return
    }
    online = true
    const { status, text } = reply
    // Клиент готов слушать — открываем поток уведомлений сервера.
    if ((message as { method?: unknown }).method === 'notifications/initialized') listen()
    if (status === 202 || text === '') return
    if (status !== 200) {
      const id = idOf(message)
      if (id !== undefined)
        write({ jsonrpc: '2.0', id, error: { code: -32000, message: `cnv: HTTP ${status} ${text}` } })
      return
    }
    const response = JSON.parse(text) as unknown
    for (const item of Array.isArray(response) ? response : [response]) write(item)
  } catch (error) {
    const id = idOf(message)
    if (id === undefined) return
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
    })
  }
}

const rl = readline.createInterface({ input: process.stdin })
const inflight = new Set<Promise<void>>()
rl.on('line', (line) => {
  if (!line.trim()) return
  const job = forward(line).finally(() => inflight.delete(job))
  inflight.add(job)
})
rl.on('close', () => {
  // Передали дела новому мосту — он и закроется вместе с клиентом, а мы ждём его.
  if (handedOver) return
  void Promise.allSettled([...inflight]).then(() => process.exit(0))
})

// Новый мост после перерождения: клиент уже подключён — сразу просим перечитать инструменты.
if (GENERATION > 0) recover()
