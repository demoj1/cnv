import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import type { AgentContext, AgentLetter, AgentMcp, AgentPlugin, AgentSessionInfo } from '@shared/agent-plugin'
import { agentSystemPrompt, shellQuote } from '../agent-session'
import { DEFAULT_AGENT, type AgentRegistry } from './registry'

export interface AgentStart {
  nodeId: string
  cwd?: string
  name?: string
  role?: string
  agent: { plugin?: string; sessionId: string; prompt?: string; model?: string }
}

export interface AgentLauncherDeps {
  registry: AgentRegistry
  /** Команда из настроек для плагина; пусто — его собственная. */
  commandFor(pluginId: string): string | undefined
  mcp(): AgentMcp | null
  /** Нашлась сессия нового агента: её надо сохранить в ноде. */
  onSession(nodeId: string, sessionId: string): void
  platform?: string
}

/** Опрос `getSession`: сперва часто — Claude и Codex заводят сессию сразу, потом реже. */
/** Сколько после запуска агента cnv ждёт его стартовый диалог. */
const STARTUP_MS = 60_000
/** Сколько письма ждут первое сообщение; само сообщение ждёт пустого поля ввода без срока. */
const FIRST_MESSAGE_MS = 10 * 60_000
const POLL_FAST_MS = 1500
const POLL_SLOW_MS = 4000
const FAST_FOR_MS = 60_000

/**
 * Запуск агента по контракту плагина: продолжить сохранённую сессию или начать новую и
 * дождаться её id. Здесь же учёт: какая сессия у какого живого агента — две ноды не
 * должны продолжать один разговор (копия ноды, вставка, правка файла руками).
 */
/** С чем запущен живой агент: письма ему доставляет его же плагин. */
interface RunningAgent {
  plugin: AgentPlugin
  ctx: AgentContext
  resumed?: boolean
  startedAt: number
  answered?: boolean
  /** Первое сообщение, которое ещё не вставлено в поле ввода. */
  firstMessage?: string
  /** С какого момента оно ждёт поле: на паузе сдвигается — заморозка срок не ест. */
  firstSince?: number
  /** Срок вышел: письма больше не ждут его, а оно ждёт поле дальше. */
  firstLate?: boolean
}

export class AgentLauncher {
  private sessions = new Map<string, string>()
  private watchers = new Map<string, () => void>()
  private running = new Map<string, RunningAgent>()

  constructor(private deps: AgentLauncherDeps) {}

  /** Строка для шелла агента. Ошибку плагина не прячем: она печатается в его же терминал. */
  async commandLine(start: AgentStart): Promise<string> {
    this.stopped(start.nodeId)
    const pluginId = start.agent.plugin || DEFAULT_AGENT
    const plugin = this.deps.registry.get(pluginId)
    const platform = this.deps.platform ?? process.platform
    const quote = (v: string): string => shellQuote(v, platform)
    if (!plugin) return `echo ${quote(`cnv: нет плагина агента «${pluginId}» — см. настройки «Агенты»`)}`

    const saved = start.agent.sessionId
    const busy =
      saved !== '' && [...this.sessions].some(([node, id]) => node !== start.nodeId && id === saved)
    const ctx = this.context(plugin, start, saved && !busy ? saved : crypto.randomUUID(), quote)
    const startedAt = Date.now()
    const run: RunningAgent = { plugin, ctx, startedAt }
    this.running.set(start.nodeId, run)
    try {
      const alive = saved && !busy && (await this.alive(plugin, ctx))
      if (this.running.get(start.nodeId) !== run) return ''
      if (alive) {
        const line = await plugin.resume(ctx)
        if (this.running.get(start.nodeId) !== run) return ''
        this.sessions.set(start.nodeId, saved)
        this.running.set(start.nodeId, { plugin, ctx, resumed: true, startedAt })
        return line
      }
      const fresh: AgentContext = { ...ctx, ...(start.agent.prompt ? { prompt: start.agent.prompt } : {}) }
      const line = await plugin.start(fresh)
      if (this.running.get(start.nodeId) !== run) return ''
      const first = plugin.inputDraft ? await plugin.firstMessage?.(fresh) : null
      if (this.running.get(start.nodeId) !== run) return ''
      if (first) {
        run.firstMessage = first
        run.firstSince = Date.now()
      }
      this.watch(plugin, fresh, Date.now())
      return line
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `echo ${quote(`cnv: агент «${plugin.label}» не запустился: ${message}`)}`
    }
  }

  /** Терминал остановлен: сессия свободна, искать её больше незачем. */
  stopped(nodeId: string): void {
    this.watchers.get(nodeId)?.()
    this.watchers.delete(nodeId)
    this.sessions.delete(nodeId)
    this.running.delete(nodeId)
  }

  /** Агент продолжил свою прошлую сессию (а не начал новую). */
  resumed(nodeId: string): boolean {
    return this.running.get(nodeId)?.resumed === true
  }

  /** Агент запущен с каналом cnv — письма ему идут уведомлением MCP. */
  usesChannel(nodeId: string): boolean {
    const run = this.running.get(nodeId)
    return Boolean(run?.plugin.mcpChannel && run.ctx.mcp?.channels)
  }

  /** Письмо своим способом плагина; false — не умеет или не вышло. */
  async deliver(nodeId: string, letter: AgentLetter): Promise<boolean> {
    const run = this.running.get(nodeId)
    if (!run?.plugin.deliver) return false
    const sessionId = this.sessions.get(nodeId) ?? run.ctx.sessionId
    return (await run.plugin.deliver({ ...run.ctx, sessionId }, letter)) === true
  }

  /** Черновик в поле ввода по экрану; undefined — плагин этого не умеет. */
  inputDraft(nodeId: string, screen: string): string | null | undefined {
    const run = this.running.get(nodeId)
    if (!run?.plugin.inputDraft) return undefined
    try {
      return run.plugin.inputDraft(screen)
    } catch {
      return null
    }
  }

  /** Агенты, у которых сейчас может висеть стартовый диалог: первая минута, ещё не ответили. */
  starting(now = Date.now()): string[] {
    return [...this.running]
      .filter(([, r]) => r.plugin.startupAnswer && !r.answered && now - r.startedAt < STARTUP_MS)
      .map(([id]) => id)
  }

  /** Что нажать в стартовом диалоге агента; null — диалога нет. Отвечаем один раз. */
  startupAnswer(nodeId: string, screen: string): string | null {
    const run = this.running.get(nodeId)
    if (!run?.plugin.startupAnswer || run.answered) return null
    let keys: string | null
    try {
      keys = run.plugin.startupAnswer(screen)
    } catch {
      keys = null
    }
    if (keys) run.answered = true
    return keys
  }

  /** Агенты, чьё первое сообщение ждёт пустое поле ввода. Срок вышел — ждём дальше, но письма отпускаем. */
  awaitingFirstMessage(now = Date.now()): string[] {
    const ids: string[] = []
    for (const [id, run] of this.running) {
      if (run.firstMessage === undefined) continue
      if (!run.firstLate && now - (run.firstSince ?? run.startedAt) >= FIRST_MESSAGE_MS) {
        run.firstLate = true
        console.warn(`[agents] ${run.plugin.id}: поле ввода не нашлось за 10 мин — первое сообщение ждёт, письма идут`)
      }
      ids.push(id)
    }
    return ids
  }

  /** Письма раньше первого сообщения не уходят — но не вечно: после срока идут, сообщение догонит. */
  awaitsFirstMessage(nodeId: string): boolean {
    const run = this.running.get(nodeId)
    return run?.firstMessage !== undefined && run.firstLate !== true
  }

  /** Агент заморожен (пауза): срок ожидания первого сообщения за него не тикает. */
  holdFirstMessage(nodeId: string): void {
    const run = this.running.get(nodeId)
    if (run?.firstMessage !== undefined && run.firstLate !== true) run.firstSince = Date.now()
  }

  /** Первое сообщение агенту, если по экрану его поле ввода пусто. Вставку завершай firstMessageSent. */
  firstMessage(nodeId: string, screen: string): string | null {
    const run = this.running.get(nodeId)
    const text = run?.firstMessage
    if (text === undefined || !run?.plugin.inputDraft) return null
    let draft: string | null
    try {
      draft = run.plugin.inputDraft(screen)
    } catch {
      draft = null
    }
    if (draft !== '') return null
    return text
  }

  /** Первое сообщение вставлено и отправлено: больше не ждём, письма можно. */
  firstMessageSent(nodeId: string): void {
    const run = this.running.get(nodeId)
    if (run) delete run.firstMessage
  }

  sessionOf(nodeId: string): string | undefined {
    return this.sessions.get(nodeId)
  }

  private async alive(plugin: AgentPlugin, ctx: AgentContext): Promise<boolean> {
    if (!plugin.hasSession) return true
    try {
      return await plugin.hasSession(ctx)
    } catch {
      return false
    }
  }

  private context(
    plugin: AgentPlugin,
    start: AgentStart,
    sessionId: string,
    quote: (v: string) => string
  ): AgentContext {
    const cwd = start.cwd && fs.existsSync(start.cwd) ? start.cwd : os.homedir()
    return {
      nodeId: start.nodeId,
      ...(start.name ? { name: start.name } : {}),
      ...(start.role ? { role: start.role } : {}),
      cwd,
      command: this.deps.commandFor(plugin.id)?.trim() || plugin.command,
      sessionId,
      ...(start.agent.model ? { model: start.agent.model } : {}),
      systemPrompt: agentSystemPrompt(start.name, start.role),
      mcp: this.deps.mcp(),
      platform: this.deps.platform ?? process.platform,
      quote,
      dataDir: this.deps.registry.dataDir(plugin.id)
    }
  }

  private watch(plugin: AgentPlugin, ctx: AgentContext, startedAt: number): void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    const cancel = (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    const poll = async (): Promise<void> => {
      timer = null
      const taken = new Set([...this.sessions].filter(([node]) => node !== ctx.nodeId).map(([, id]) => id))
      let found: string | null = null
      try {
        found = await plugin.getSession({ ...ctx, startedAt, taken })
      } catch (error) {
        console.error(`[agents] ${plugin.id}.getSession:`, error)
      }
      if (cancelled) return
      if (typeof found === 'string' && found && !taken.has(found)) {
        this.watchers.delete(ctx.nodeId)
        this.sessions.set(ctx.nodeId, found)
        this.deps.onSession(ctx.nodeId, found)
        return
      }
      const delay = Date.now() - startedAt < FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS
      timer = setTimeout(() => void poll(), delay)
    }
    this.watchers.set(ctx.nodeId, cancel)
    void poll()
  }
}

/**
 * Сессии агента в папке — для «Продолжить сессию…». Контекст урезанный: плагину нужны
 * только папка, команда и своя папка данных.
 */
export async function listAgentSessions(
  registry: AgentRegistry,
  pluginId: string,
  cwd: string | undefined,
  command?: string
): Promise<AgentSessionInfo[]> {
  const plugin = registry.get(pluginId || DEFAULT_AGENT)
  if (!plugin?.listSessions) return []
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir()
  const sessions = await plugin.listSessions({
    nodeId: '',
    cwd: dir,
    command: command?.trim() || plugin.command,
    sessionId: '',
    systemPrompt: '',
    mcp: null,
    platform: process.platform,
    quote: (v) => shellQuote(v),
    dataDir: registry.dataDir(plugin.id)
  })
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
}
