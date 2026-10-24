import type { DocNode } from './document'

/**
 * Терминал живёт в обычной текстовой ноде, помеченной полем `x-cnv`. Своего типа в
 * JSON Canvas для него нет, а выдумывать — значит потерять совместимость: Obsidian
 * покажет такую ноду карточкой с подписью и ничего не сломает, а неизвестные поля он
 * сохраняет (это у нас проверено на живом редакторе).
 */
export interface TerminalSpec {
  /** Рабочая папка. Процесс перезапуск приложения не переживает, а папка — да. */
  cwd?: string
  /** Имя для людей и агентов: «Задумчивый Даня». Уникально на холсте. */
  name?: string
  /** Роль: «ревьюер», «пишет тесты» — чтобы агенты понимали, кто есть кто. */
  role?: string
  /** Есть — это агент: в терминале сам запускается его программа и переживает перезапуск. */
  agent?: AgentSpec
}

export interface AgentSpec {
  /** id плагина агента: `claude`, `codex`… Нет — Claude Code (так писали канвасы до плагинов). */
  plugin?: string
  /**
   * id сессии агента: по нему он продолжает разговор после перезапуска. Пустая строка —
   * сессии ещё нет: агент её начнёт, а cnv запишет сюда её id.
   */
  sessionId: string
  /** Первое сообщение агенту; уходит при первом запуске и стирается. */
  prompt?: string
}

const KEY = 'x-cnv'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

/** Агент без `sessionId` — тоже агент: так пишут готовые канвасы-примеры. Сессию он начнёт сам. */
function agentSpec(value: unknown): AgentSpec | undefined {
  if (!isRecord(value)) return undefined
  const out: AgentSpec = { sessionId: typeof value.sessionId === 'string' ? value.sessionId : '' }
  if (typeof value.plugin === 'string' && value.plugin) out.plugin = value.plugin
  if (typeof value.prompt === 'string') out.prompt = value.prompt
  return out
}

export function terminalSpec(node: DocNode): TerminalSpec | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  if (!isRecord(own)) return null
  const spec = own.terminal
  if (!isRecord(spec)) return null
  const out: TerminalSpec = {}
  if (typeof spec.cwd === 'string') out.cwd = spec.cwd
  if (typeof spec.name === 'string') out.name = spec.name
  if (typeof spec.role === 'string' && spec.role) out.role = spec.role
  const agent = agentSpec(spec.agent)
  if (agent) out.agent = agent
  return out
}

export const isTerminal = (node: DocNode): boolean => terminalSpec(node) !== null
export const isAgent = (node: DocNode): boolean => terminalSpec(node)?.agent !== undefined

/** Пометка терминала в `extra`, поверх уже лежащих там чужих полей и прежней спеки. */
export function withTerminalSpec(
  extra: Record<string, unknown>,
  spec: TerminalSpec
): Record<string, unknown> {
  const own = extra[KEY]
  const base = isRecord(own) ? own : {}
  const prev = isRecord(base.terminal) ? base.terminal : {}
  return { ...extra, [KEY]: { ...base, terminal: { ...prev, ...spec } } }
}

/** Снять первое сообщение агента: оно одноразовое. */
export function withoutAgentPrompt(
  extra: Record<string, unknown>,
  agent: AgentSpec
): Record<string, unknown> {
  const rest: AgentSpec = { sessionId: agent.sessionId, ...(agent.plugin ? { plugin: agent.plugin } : {}) }
  return withTerminalSpec(extra, { agent: rest })
}

/** Агент начал сессию — запомнить её, чтобы следующий запуск её продолжил. */
export function withAgentSession(
  extra: Record<string, unknown>,
  agent: AgentSpec,
  sessionId: string
): Record<string, unknown> {
  return withTerminalSpec(extra, { agent: { ...agent, sessionId } })
}

/** Текст карточки: то, что увидит Obsidian, открыв наш канвас. */
export const terminalPlaceholder = (shell: string, name?: string, agent?: boolean): string =>
  `\`${agent ? 'агент' : 'терминал'}${name ? ` «${name}»` : ''}: ${shell}\``
