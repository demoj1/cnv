import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentContext,
  AgentLetter,
  AgentPlugin,
  AgentSessionInfo,
  AgentSessionQuery
} from '@shared/agent-plugin'

/**
 * OpenCode. id сессии (`ses_…`) он выбирает сам и заводит её с первым сообщением;
 * `getSession` ищет её в его базе по папке и времени. Конфиг — через
 * `OPENCODE_CONFIG_CONTENT`: он складывается с конфигом пользователя, ничего не
 * перезаписывая. Токен холста OpenCode подставит сам из `{env:…}`.
 */

const dataHome = (): string => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
const dbFile = (): string => path.join(dataHome(), 'opencode', 'opencode.db')

/**
 * Порт HTTP-сервера OpenCode у каждой ноды. Без `--port` TUI ходит в свой сервер внутри
 * процесса, и снаружи в сессию не попасть; с ним письма cnv кладутся в сессию по API —
 * в ленту, мимо поля ввода. Живёт, пока жив cnv: после перезапуска агент получит новый.
 */
const ports = new Map<string, number>()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

async function portArgs(ctx: AgentContext): Promise<string> {
  const port = await freePort()
  ports.set(ctx.nodeId, port)
  return `--port ${port}`
}

/** POST в сервер OpenCode; свой агент — мимо прокси из окружения, это loopback. */
function postJson(url: string, body: unknown): Promise<number> {
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: new http.Agent(),
        timeout: 10_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('timeout', () => req.destroy(new Error('OpenCode не ответил')))
    req.on('error', reject)
    req.end(text)
  })
}

/** Письмо — в сессию OpenCode через его API: появится в ленте, черновик в поле ввода цел. */
export async function deliverToOpencode(ctx: AgentContext, letter: AgentLetter): Promise<boolean> {
  const port = ports.get(ctx.nodeId)
  // Сессия у OpenCode заводится с первым сообщением: пока её нет — пусть cnv вставит сам.
  if (!port || !SESSION_ID.test(ctx.sessionId)) return false
  const url = `http://127.0.0.1:${port}/session/${ctx.sessionId}/prompt_async?directory=${encodeURIComponent(path.resolve(ctx.cwd))}`
  const status = await postJson(url, { parts: [{ type: 'text', text: letter.text }] })
  return status >= 200 && status < 300
}

function configLine(ctx: AgentContext): string {
  if (ctx.platform === 'win32') throw new Error('OpenCode из cnv пока запускается только в Linux и macOS')
  const instructions = path.join(ctx.dataDir, `${ctx.nodeId}.md`)
  fs.writeFileSync(instructions, ctx.systemPrompt, 'utf8')
  const config: Record<string, unknown> = { instructions: [instructions] }
  if (ctx.mcp) {
    config.mcp = {
      cnv: {
        type: 'remote',
        url: ctx.mcp.url,
        headers: { Authorization: `Bearer {env:${ctx.mcp.tokenEnv}}` }
      }
    }
  }
  return `env OPENCODE_CONFIG_CONTENT=${ctx.quote(JSON.stringify(config))} ${ctx.command}`
}

interface Row {
  id: string
  directory: string
  created: number
}

/** Сессии из базы OpenCode: sqlite в Node есть с 22-й версии, а cnv работает на Node из Electron. */
async function sessionsFromDb(sql: string, params: (string | number)[]): Promise<Row[] | null> {
  if (!fs.existsSync(dbFile())) return []
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile(), { readOnly: true })
    try {
      return db.prepare(sql).all(...params) as unknown as Row[]
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Запасной путь, если базу не открыть: сам OpenCode знает свои сессии. */
function sessionsFromCli(command: string): Promise<Row[]> {
  return new Promise((resolve) => {
    // В команде из настроек бывают аргументы (`opencode -m …`) — нужен только сам бинарь.
    const bin = command.trim().split(/\s+/)[0] ?? 'opencode'
    execFile(
      bin,
      ['session', 'list', '--format', 'json', '-n', '50'],
      { timeout: 15_000 },
      (error, stdout) => {
        if (error) return resolve([])
        try {
          const list = JSON.parse(stdout) as { id: string; directory: string; created: number }[]
          resolve(list.map((s) => ({ id: s.id, directory: s.directory, created: s.created })))
        } catch {
          resolve([])
        }
      }
    )
  })
}

export async function findOpencodeSession(query: AgentSessionQuery): Promise<string | null> {
  const cwd = path.resolve(query.cwd)
  const since = query.startedAt - 5000
  const rows =
    (await sessionsFromDb(
      'SELECT id, directory, time_created AS created FROM session ' +
        'WHERE parent_id IS NULL AND directory = ? AND time_created >= ? ORDER BY time_created',
      [cwd, since]
    )) ?? (await sessionsFromCli(query.command))
  const mine = rows
    .filter((r) => path.resolve(r.directory) === cwd && r.created >= since && !query.taken.has(r.id))
    .sort((a, b) => a.created - b.created)
  return mine[0]?.id ?? null
}

const SESSION_ID = /^ses_[0-9a-z]+$/i

/** Бесплатная модель с вызовом инструментов — список: `opencode models | grep free`. */
export const FREE_MODEL = 'opencode/deepseek-v4.1-flash-free'

export const opencodePlugin: AgentPlugin = {
  id: 'opencode',
  label: 'OpenCode',
  // Бесплатная модель OpenCode Zen: работает без своих ключей. Другую — в настройках.
  command: `opencode -m ${FREE_MODEL}`,
  description: 'OpenCode: сессия появляется с первым сообщением, продолжение — --session',
  async start(ctx) {
    const parts = [configLine(ctx), await portArgs(ctx)]
    if (ctx.prompt) parts.push('--prompt', ctx.quote(ctx.prompt))
    return parts.join(' ')
  },
  async resume(ctx) {
    if (!SESSION_ID.test(ctx.sessionId)) throw new Error(`кривой id сессии: ${ctx.sessionId}`)
    return [configLine(ctx), await portArgs(ctx), '--session', ctx.sessionId].join(' ')
  },
  deliver: deliverToOpencode,
  getSession: (query) => findOpencodeSession(query),
  async listSessions(ctx): Promise<AgentSessionInfo[]> {
    const rows = (await sessionsFromDb(
      'SELECT id, directory, time_created AS created, time_updated AS updated, title FROM session ' +
        'WHERE parent_id IS NULL AND directory = ? ORDER BY time_updated DESC LIMIT 30',
      [path.resolve(ctx.cwd)]
    )) as (Row & { updated: number; title?: string })[] | null
    return (rows ?? []).map((r) => ({
      id: r.id,
      updatedAt: r.updated,
      ...(r.title ? { title: r.title } : {})
    }))
  },
  async hasSession(ctx) {
    const rows = await sessionsFromDb(
      'SELECT id, directory, time_created AS created FROM session WHERE id = ?',
      [ctx.sessionId]
    )
    // Базу не открыть — верим сохранённому id: OpenCode сам скажет, если сессии нет.
    return rows === null ? true : rows.length > 0
  }
}
