import fs from 'node:fs'
import path from 'node:path'
import type { AgentLetter } from '@shared/agent-plugin'

/**
 * Почтальон писем агентам. Письмо не должно врезаться в то, что человек набирает агенту, —
 * поэтому сперва пути мимо поля ввода, и только потом вставка в терминал:
 * 1. Канал (MCP channels Claude Code): уведомление в MCP-соединение агента.
 * 2. Свой способ плагина (`deliver`): HTTP API агента (OpenCode).
 * 3. Вставка в терминал — если в поле ввода пусто. Черновик видно по экрану (плагин умеет
 *    его разобрать), а нет — по нажатиям. Пока черновик есть, письма ждут в очереди и
 *    уходят по порядку, как только поле опустеет.
 */

export type LetterRoute = 'channel' | 'agent' | 'terminal' | 'queued'

export interface LetterPostDeps {
  isRunning(nodeId: string): boolean
  isPaused?(nodeId: string): boolean
  isReady?(nodeId: string): boolean
  write(nodeId: string, data: string): void
  sleep(ms: number): Promise<void>
  /** Экран терминала без тусклых подсказок; null — терминала на холсте нет. */
  readScreen(nodeId: string): Promise<string | null>
  /** Черновик по экрану: строка — набранное, null — не разобрать, undefined — плагин не умеет. */
  inputDraft(nodeId: string, screen: string): string | null | undefined
  humanTyping(nodeId: string): { draft: boolean; idleMs: number }
  /** Агент ноды запущен с каналом cnv. */
  usesChannel(nodeId: string): boolean
  hasStream(nodeId: string): boolean
  push(nodeId: string, message: unknown): number
  /** Свой способ доставки плагина; false — не умеет или не вышло. */
  deliver(nodeId: string, letter: AgentLetter): Promise<boolean>
}

/** Claude Code вставку переваривает не мгновенно — Enter отдельно и чуть позже. */
export const PASTE_SETTLE_MS = 150
/** Агент с каналом ещё поднимается (или ждёт подтверждения канала) — столько ждём потока. */
const CHANNEL_WAIT_MS = 120_000
/** Черновик по нажатиям без экрана: человек не печатал столько — бросил, письма идут. */
const TYPING_ABANDON_MS = 120_000
/** Черновик виден на экране, а человек молчит столько — письма всё-таки вставляются. */
const SCREEN_ABANDON_MS = 10 * 60_000
const FLUSH_MS = 1000
/** Терминала нет и он не на паузе столько — нода удалена или закрыта: письма выбрасываем. */
const GONE_MS = 5 * 60_000

interface Queue {
  letters: AgentLetter[]
  /** С какого момента письма ждут — для таймаутов канала и брошенного черновика. */
  since: number
  /** С какого момента процесса нет (а пауза не стоит). */
  goneSince?: number
}

export class LetterPost {
  private queues = new Map<string, Queue>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
  private stopped = false
  private delivering = new Set<string>()

  constructor(
    private readonly deps: LetterPostDeps,
    private readonly file?: string
  ) {
    if (!file) return
    try {
      this.queues = new Map(JSON.parse(fs.readFileSync(file, 'utf8')) as [string, Queue][])
      if (this.queues.size) this.timer = setInterval(() => void this.flush(), FLUSH_MS)
    } catch {
      /* Новая очередь. */
    }
  }

  private save(): void {
    if (!this.file || this.stopped) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify([...this.queues]), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }

  /** Сколько писем ждут у ноды. */
  pending(nodeId: string): number {
    return this.queues.get(nodeId)?.letters.length ?? 0
  }

  async send(nodeId: string, letter: AgentLetter): Promise<LetterRoute> {
    // Резервируем очередь ДО первого await: одновременные письма не затрут друг друга.
    const existing = this.queues.get(nodeId)
    if (existing) {
      existing.letters.push(letter)
      this.save()
      return 'queued'
    }
    const queue: Queue = { letters: [letter], since: Date.now() }
    this.queues.set(nodeId, queue)
    this.save()
    this.delivering.add(nodeId)
    try {
      const route = await this.tryNow(nodeId, letter, 0)
      if (route) {
        queue.letters.shift()
        if (!queue.letters.length) this.queues.delete(nodeId)
        this.save()
      }
      return route ?? 'queued'
    } finally {
      this.delivering.delete(nodeId)
      if (!this.stopped && this.queues.size) this.timer ??= setInterval(() => void this.flush(), FLUSH_MS)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.queues.clear()
  }

  /** Доставить сейчас, если можно; null — пока нельзя (ждём канал или пустое поле ввода). */
  private async tryNow(nodeId: string, letter: AgentLetter, waitedMs: number): Promise<LetterRoute | null> {
    const { deps } = this
    if (this.stopped) return null
    if (deps.isPaused?.(nodeId) || !deps.isRunning(nodeId) || deps.isReady?.(nodeId) === false) return null
    if (deps.usesChannel(nodeId)) {
      if (deps.hasStream(nodeId) && deps.push(nodeId, channelMessage(letter)) > 0) return 'channel'
      if (waitedMs < CHANNEL_WAIT_MS) return null
    }
    try {
      if (await deps.deliver(nodeId, letter)) return 'agent'
    } catch {
      // Свой способ сломался — доставим как раньше.
    }
    const draft = await this.draft(nodeId, waitedMs)
    if (deps.isPaused?.(nodeId) || !deps.isRunning(nodeId) || deps.isReady?.(nodeId) === false) return null
    if (draft === 'typed') return null
    // Агент с каналом, а экран не его поле ввода (стартовый диалог канала, полноэкранный
    // режим): вставка ушла бы в диалог, а Enter выбрал бы пункт меню — ждём дальше.
    if (draft === 'unknown' && deps.usesChannel(nodeId)) return null
    deps.write(nodeId, `\x1b[200~${letter.text}\x1b[201~`)
    await deps.sleep(PASTE_SETTLE_MS)
    if (deps.isPaused?.(nodeId) || !deps.isRunning(nodeId) || deps.isReady?.(nodeId) === false) return null
    deps.write(nodeId, '\r')
    return 'terminal'
  }

  /** Что в поле ввода: typed — черновик, empty — пусто, unknown — экран не разобрать. */
  private async draft(nodeId: string, waitedMs: number): Promise<'typed' | 'empty' | 'unknown'> {
    const typing = this.deps.humanTyping(nodeId)
    const screen = await this.deps.readScreen(nodeId).catch(() => null)
    const draft = screen === null ? undefined : this.deps.inputDraft(nodeId, screen)
    if (typeof draft === 'string') {
      // Экран — правда: стёр Backspace-ами — пусто, вставил мышью — черновик.
      const held = draft !== '' && (typing.idleMs < SCREEN_ABANDON_MS || waitedMs < SCREEN_ABANDON_MS)
      return held ? 'typed' : 'empty'
    }
    if (typing.draft && typing.idleMs < TYPING_ABANDON_MS) return 'typed'
    return draft === null ? 'unknown' : 'empty'
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const [nodeId, queue] of [...this.queues]) {
        if (this.delivering.has(nodeId)) continue
        // Пауза и перезапуск процесса не теряют принятые письма; удалённая нода — теряет.
        if (this.deps.isPaused?.(nodeId)) {
          queue.since = Date.now()
          delete queue.goneSince
          continue
        }
        if (!this.deps.isRunning(nodeId)) {
          queue.since = Date.now()
          queue.goneSince ??= Date.now()
          if (Date.now() - queue.goneSince > GONE_MS) {
            this.queues.delete(nodeId)
            this.save()
          }
          continue
        }
        delete queue.goneSince
        while (queue.letters.length > 0) {
          const next = queue.letters[0] as AgentLetter
          const route = await this.tryNow(nodeId, next, Date.now() - queue.since)
          if (!route) break
          queue.letters.shift()
          this.save()
        }
        if (queue.letters.length === 0) this.queues.delete(nodeId)
      }
      if (this.queues.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    } finally {
      this.flushing = false
    }
  }
}

/**
 * Уведомление канала Claude Code: модель видит `<channel source="cnv" msg_id=…>текст</channel>`.
 * Ключи meta — только латиница, цифры и `_`, иначе Claude Code их молча выбросит.
 */
export function channelMessage(letter: AgentLetter): unknown {
  const meta: Record<string, string> = { msg_id: letter.id }
  if (letter.from) {
    meta.from_id = letter.from.id
    if (letter.from.name) meta.from = letter.from.name
  }
  return { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: letter.text, meta } }
}
