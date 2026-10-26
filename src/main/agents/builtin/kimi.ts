import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentSystemPrompt } from '../../agent-session'
import { withModel } from './model'
import type {
  AgentContext,
  AgentMcp,
  AgentPlugin,
  AgentSessionInfo,
  AgentSessionQuery
} from '@shared/agent-plugin'

/**
 * Kimi Code (Moonshot). id сессии (`session_<uuid>`) он выбирает сам и заводит её с первым
 * сообщением; `getSession` ищет её `state.json` в `<KIMI_CODE_HOME>/sessions/<папка>/<id>/`
 * по `cwd` и `createdAt`. Продолжение — `kimi --session <id>`.
 *
 * Флагов на один запуск у Kimi мало:
 * - MCP-конфига на запуск нет, только `<KIMI_CODE_HOME>/mcp.json`. Туда cnv кладёт запись
 *   `cnv` со stdio-мостом `cnv-mcp`, как `claude mcp add -s user`: окружение терминала мост
 *   наследует и находит свою ноду сам, а снаружи cnv он — пустой сервер.
 * - Ни задания, ни системного промпта интерактивный Kimi флагами не берёт (`-p` — только без
 *   TUI, `--agent-file` в TUI 2.3 молча пропускается): то и другое cnv вставляет первым
 *   сообщением (`firstMessage`).
 */

const kimiHome = (): string => process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code')

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const BRIDGE = /^(cnv-mcp(\.cmd)?|mcp-stdio\.cjs)$/i

/**
 * Запись — мост cnv, где бы он ни лежал: `cnv-mcp`, а в Windows — электрон cnv со скриптом
 * моста `mcp-stdio.cjs` в аргументах.
 */
function isBridge(entry: unknown): entry is Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.command !== 'string') return false
  const parts = [entry.command, ...(Array.isArray(entry.args) ? (entry.args as unknown[]) : [])]
  return parts.some((p) => typeof p === 'string' && BRIDGE.test(path.basename(p)))
}

/**
 * Сервер холста — в `mcp.json` Kimi. Остальные серверы и своя запись `cnv` человека остаются
 * как были; мост cnv по старому пути (другая установка cnv) переводится на нынешний, а свои
 * поля записи (таймауты и т. п.) остаются. Файл, который не разобрать, не трогаем.
 */
export function registerKimiMcp(mcp: AgentMcp, home = kimiHome()): void {
  const file = path.join(home, 'mcp.json')
  let text = ''
  let mode = 0o600
  try {
    text = fs.readFileSync(file, 'utf8')
    mode = fs.statSync(file).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let config: unknown = {}
  if (text.trim()) {
    try {
      config = JSON.parse(text)
    } catch {
      throw new Error(`${file} — не JSON, холст к Kimi не подключить`)
    }
  }
  const servers = isRecord(config) ? (config.mcpServers ?? {}) : null
  if (!isRecord(config) || !isRecord(servers)) {
    throw new Error(`${file} — не { mcpServers: {...} }, холст к Kimi не подключить`)
  }
  const { command, args, env } = mcp.stdio
  const own = Object.hasOwn(servers, mcp.serverName) ? servers[mcp.serverName] : undefined
  if (own !== undefined && !isBridge(own)) return
  if (isBridge(own) && own.command === command && JSON.stringify(own.args ?? []) === JSON.stringify(args)) {
    return
  }
  const kept = isBridge(own)
    ? Object.fromEntries(Object.entries(own).filter(([k]) => !['command', 'args', 'env'].includes(k)))
    : {}
  servers[mcp.serverName] = {
    ...kept,
    command,
    ...(args.length ? { args } : {}),
    ...(Object.keys(env).length ? { env } : {})
  }
  fs.mkdirSync(home, { recursive: true })
  // Через временный файл: Kimi следит за mcp.json и не должен прочитать его недописанным.
  const tmp = `${file}.cnv-${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, { mode })
  fs.renameSync(tmp, file)
}

const SESSION_ID = /^session_[0-9a-f-]{36}$/i

interface KimiSession {
  id: string
  cwd: string
  createdAt: number
  updatedAt: number
  title?: string
  /** Последнее сообщение человека — у свежей сессии это первое. */
  prompt?: string
  archived: boolean
}

/** `state.json` сессий: `<home>/sessions/<папка>/<id>/`; `since` — не старше (по mtime). */
function stateFiles(home: string, since = 0): string[] {
  const root = path.join(home, 'sessions')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return []
  }
  const files: string[] = []
  for (const dir of dirs) {
    let ids: string[]
    try {
      ids = fs.readdirSync(path.join(root, dir))
    } catch {
      continue
    }
    for (const id of ids) {
      if (!SESSION_ID.test(id)) continue
      const file = path.join(root, dir, id, 'state.json')
      try {
        if (fs.statSync(file).mtimeMs < since) continue
      } catch {
        continue
      }
      files.push(file)
    }
  }
  return files
}

function readState(file: string): KimiSession | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      id?: unknown
      cwd?: unknown
      createdAt?: unknown
      updatedAt?: unknown
      title?: unknown
      lastPrompt?: unknown
      archived?: unknown
    }
    if (typeof s.id !== 'string' || typeof s.cwd !== 'string') return null
    return {
      id: s.id,
      cwd: s.cwd,
      createdAt: Number(s.createdAt) || 0,
      updatedAt: Number(s.updatedAt) || 0,
      ...(typeof s.title === 'string' && s.title ? { title: s.title } : {}),
      ...(typeof s.lastPrompt === 'string' && s.lastPrompt ? { prompt: s.lastPrompt } : {}),
      archived: s.archived === true
    }
  } catch {
    return null
  }
}

function sessionsIn(cwd: string, home: string, since = 0): KimiSession[] {
  const want = path.resolve(cwd)
  return stateFiles(home, since)
    .map(readState)
    .filter((s): s is KimiSession => s !== null && path.resolve(s.cwd) === want)
}

/** Kimi в заголовке и lastPrompt сводит переводы строк в пробелы — сравниваем так же. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Начало первого сообщения любого агента cnv — его системного промпта. */
const CNV_SIGN = flat(agentSystemPrompt(undefined, undefined)).slice(0, 10)
const FIRST_TASK = 'Первое задание:'

export function findKimiSession(query: AgentSessionQuery, home = kimiHome()): string | null {
  // Сессию Kimi заводит с первым сообщением, а оно уходит после старта: запас по времени не
  // нужен, а с ним новый агент забрал бы сессию только что удалённого в той же папке.
  const fresh = sessionsIn(query.cwd, home, query.startedAt)
    .filter((s) => s.createdAt >= query.startedAt && !query.taken.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt)
  const texts = (s: KimiSession): string[] =>
    [s.title, s.prompt].filter((t): t is string => Boolean(t)).map(flat)
  // Агентов, запущенных в одной папке разом, различает первое сообщение: в нём имя агента.
  const first = flat(kimiFirstMessage(query)).slice(0, 80)
  const ours = fresh.find((s) => texts(s).some((t) => t.startsWith(first) || first.startsWith(t)))
  if (ours) return ours.id
  // Человек написал агенту раньше cnv — сессия его, лишь бы не первое сообщение другого агента.
  // Без текста не берём: заголовок Kimi дописывает следом, со следующим опросом и разберёмся.
  const human = (s: KimiSession): boolean => {
    const t = texts(s)
    return t.length > 0 && !t.some((x) => x.startsWith(CNV_SIGN))
  }
  return fresh.find(human)?.id ?? null
}

export function kimiSessionExists(id: string, home = kimiHome()): boolean {
  if (!SESSION_ID.test(id)) return false
  const root = path.join(home, 'sessions')
  try {
    return fs.readdirSync(root).some((dir) => fs.existsSync(path.join(root, dir, id, 'state.json')))
  } catch {
    return false
  }
}

/**
 * Заголовок для людей. У сессии, начатой cnv, Kimi берёт его из первого сообщения, а там
 * системный промпт — показываем задание; заголовок, который Kimi придумал сам, — как есть.
 */
function shownTitle(s: KimiSession): string | undefined {
  for (const text of [s.title, s.prompt]) {
    if (!text) continue
    const t = flat(text)
    if (!t.startsWith(CNV_SIGN)) return t
    const i = t.indexOf(FIRST_TASK)
    if (i >= 0) return t.slice(i + FIRST_TASK.length).trim()
  }
  return undefined
}

/** Сессии Kimi в папке, свежие первыми. */
export function listKimiSessions(cwd: string, home = kimiHome(), limit = 30): AgentSessionInfo[] {
  return sessionsIn(cwd, home)
    .filter((s) => !s.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((s) => {
      const title = shownTitle(s)
      return { id: s.id, updatedAt: s.updatedAt, ...(title ? { title } : {}) }
    })
}

/** Кто ты и где — вместе с заданием, если оно есть. */
export function kimiFirstMessage(ctx: AgentContext): string {
  return ctx.prompt
    ? `${ctx.systemPrompt}\n\n${FIRST_TASK}\n${ctx.prompt}`
    : `${ctx.systemPrompt}\n\nЗадания пока нет: ответь одной строкой и жди.`
}

/** Рамка поля ввода Kimi Code: `╭──╮`, внутри `│ > текст │`, строки продолжения — с отступом. */
const BOX_TOP = /^\s*╭─+╮\s*$/
const BOX_BOTTOM = /^\s*╰─+╯\s*$/

/**
 * Черновик в поле ввода Kimi Code: последняя рамка `╭─╮ … ╰─╯`, первая строка в ней
 * начинается с `> `. Нет такой рамки — экран не тот (диалог доверия папке, меню): null.
 */
export function kimiInputDraft(screen: string): string | null {
  const lines = screen.split('\n')
  let bottom = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_BOTTOM.test(lines[i] ?? '')) {
      bottom = i
      break
    }
  }
  if (bottom < 0) return null
  let top = -1
  for (let i = bottom - 1; i >= 0; i--) {
    if (BOX_TOP.test(lines[i] ?? '')) {
      top = i
      break
    }
  }
  if (top < 0) return null
  const box = lines.slice(top + 1, bottom).map((l) => l.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, ''))
  const first = box[0] ?? ''
  if (!/^>(\s|$)/.test(first)) return null
  return [first.replace(/^>\s?/, ''), ...box.slice(1).map((l) => l.replace(/^ {2}/, ''))]
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

export const kimiPlugin: AgentPlugin = {
  id: 'kimi',
  label: 'Kimi Code',
  command: 'kimi',
  description: 'Moonshot Kimi Code: сессия появляется с первым сообщением, продолжение — --session',
  start(ctx) {
    if (ctx.mcp) registerKimiMcp(ctx.mcp)
    return withModel(ctx.command, ctx.model, ctx.quote)
  },
  resume(ctx) {
    if (!SESSION_ID.test(ctx.sessionId)) throw new Error(`кривой id сессии: ${ctx.sessionId}`)
    if (ctx.mcp) registerKimiMcp(ctx.mcp)
    return [withModel(ctx.command, ctx.model, ctx.quote), '--session', ctx.sessionId].join(' ')
  },
  firstMessage: kimiFirstMessage,
  getSession: (query) => findKimiSession(query),
  hasSession: (ctx) => kimiSessionExists(ctx.sessionId),
  listSessions: (ctx) => listKimiSessions(ctx.cwd),
  inputDraft: kimiInputDraft
}
