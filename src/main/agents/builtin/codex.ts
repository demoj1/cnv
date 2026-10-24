import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withModel } from './model'
import type { AgentContext, AgentPlugin, AgentSessionInfo, AgentSessionQuery } from '@shared/agent-plugin'

/**
 * OpenAI Codex CLI. id сессии он выбирает сам, поэтому `getSession` ищет её файл:
 * `<CODEX_HOME>/sessions/ГГГГ/ММ/ДД/rollout-<время>-<id>.jsonl`, первая строка —
 * `session_meta` с `cwd`. Холст подключается напрямую по HTTP: токен Codex читает из
 * переменной терминала, в командной строке его нет.
 */

const codexHome = (): string => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')

/** Значение для `-c key=value`: Codex разбирает его как TOML, а строка JSON — валидная строка TOML. */
const toml = (value: string): string => JSON.stringify(value)

function overrides(ctx: AgentContext): string[] {
  const out: string[] = []
  if (ctx.mcp) {
    const server = `{url=${toml(ctx.mcp.url)},bearer_token_env_var=${toml(ctx.mcp.tokenEnv)}}`
    out.push('-c', ctx.quote(`mcp_servers.cnv=${server}`))
  }
  out.push('-c', ctx.quote(`developer_instructions=${toml(ctx.systemPrompt)}`))
  return out
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Папки дней, где может лежать сессия: с дня старта по сегодня — и по местному, и по UTC. */
function dayDirs(home: string, since: number): string[] {
  const dirs = new Set<string>()
  for (let t = since - 86_400_000; t <= Date.now() + 86_400_000; t += 43_200_000) {
    const d = new Date(t)
    dirs.add(path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())))
    dirs.add(
      path.join(home, 'sessions', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
    )
  }
  return [...dirs]
}

interface SessionMeta {
  id: string
  cwd: string
  /** Подагенты Codex пишут свои rollout-ы с родителем — это не наша сессия. */
  parent: boolean
  timestamp: number
}

function readMeta(file: string): SessionMeta | null {
  let head: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  try {
    const first = JSON.parse(head.split('\n', 1)[0] ?? '') as {
      type?: string
      payload?: { id?: string; cwd?: string; parent_thread_id?: string | null; timestamp?: string }
    }
    const p = first.payload
    if (first.type !== 'session_meta' || !p?.id || !p.cwd) return null
    return {
      id: p.id,
      cwd: p.cwd,
      parent: Boolean(p.parent_thread_id),
      timestamp: p.timestamp ? Date.parse(p.timestamp) : 0
    }
  } catch {
    return null
  }
}

export function findCodexSession(query: AgentSessionQuery, home = codexHome()): string | null {
  const cwd = path.resolve(query.cwd)
  const found: SessionMeta[] = []
  for (const dir of dayDirs(home, query.startedAt)) {
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      // Старые файлы не открываем вовсе: сессия этого запуска пишется после старта.
      try {
        if (fs.statSync(file).mtimeMs < query.startedAt - 5000) continue
      } catch {
        continue
      }
      const meta = readMeta(file)
      if (!meta || meta.parent || query.taken.has(meta.id)) continue
      if (path.resolve(meta.cwd) !== cwd || meta.timestamp < query.startedAt - 5000) continue
      found.push(meta)
    }
  }
  found.sort((a, b) => a.timestamp - b.timestamp)
  return found[0]?.id ?? null
}

export function codexSessionExists(id: string, home = codexHome()): boolean {
  const suffix = `-${id}.jsonl`
  try {
    const files = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }) as string[]
    return files.some((f) => f.endsWith(suffix))
  } catch {
    return false
  }
}

const SESSION_ID = /^[0-9a-z-]{8,64}$/i

/** Сессии Codex в папке: свежие rollout-файлы с этим cwd; заголовки — из его session_index. */
export function listCodexSessions(cwd: string, home = codexHome(), limit = 30): AgentSessionInfo[] {
  let files: string[]
  try {
    files = (fs.readdirSync(path.join(home, 'sessions'), { recursive: true }) as string[]).filter(
      (f) => path.basename(f).startsWith('rollout-') && f.endsWith('.jsonl')
    )
  } catch {
    return []
  }
  const titles = new Map<string, string>()
  try {
    for (const line of fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      try {
        const o = JSON.parse(line) as { id?: string; thread_name?: string }
        if (o.id && o.thread_name) titles.set(o.id, o.thread_name)
      } catch {
        // битая строка индекса — без заголовка
      }
    }
  } catch {
    // индекса нет — без заголовков
  }
  const want = path.resolve(cwd)
  const out: AgentSessionInfo[] = []
  const recent = files
    .map((f) => path.join(home, 'sessions', f))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { file, mtime } of recent.slice(0, 400)) {
    const meta = readMeta(file)
    if (!meta || meta.parent || path.resolve(meta.cwd) !== want) continue
    const title = titles.get(meta.id)
    out.push({ id: meta.id, updatedAt: mtime, ...(title ? { title } : {}) })
    if (out.length >= limit) break
  }
  return out
}

export const codexPlugin: AgentPlugin = {
  id: 'codex',
  label: 'Codex',
  command: 'codex',
  description: 'OpenAI Codex CLI: сессию находим по её файлу, продолжение — codex resume',
  start(ctx) {
    const parts = [withModel(ctx.command, ctx.model, ctx.quote), ...overrides(ctx)]
    if (ctx.prompt) parts.push(ctx.quote(ctx.prompt))
    return parts.join(' ')
  },
  resume(ctx) {
    if (!SESSION_ID.test(ctx.sessionId)) throw new Error(`кривой id сессии: ${ctx.sessionId}`)
    return [withModel(ctx.command, ctx.model, ctx.quote), 'resume', ctx.sessionId, ...overrides(ctx)].join(' ')
  },
  getSession: (query) => findCodexSession(query),
  hasSession: (ctx) => codexSessionExists(ctx.sessionId),
  listSessions: (ctx) => listCodexSessions(ctx.cwd)
}
