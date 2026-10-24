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

interface Queue {
  letters: AgentLetter[]
  /** С какого момента письма ждут — для таймаутов канала и брошенного черновика. */
  since: number
}

export class LetterPost {
  private queues = new Map<string, Queue>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(private readonly deps: LetterPostDeps) {}

  /** Сколько писем ждут у ноды. */
  pending(nodeId: string): number {
    return this.queues.get(nodeId)?.letters.length ?? 0
  }

  async send(nodeId: string, letter: AgentLetter): Promise<LetterRoute> {
    // Уже есть очередь — встаём в неё: письма приходят в том порядке, в каком отправлены.
    const queue = this.queues.get(nodeId)
    if (queue) {
      queue.letters.push(letter)
      return 'queued'
    }
    const route = await this.tryNow(nodeId, letter, 0)
    if (route) return route
    this.queues.set(nodeId, { letters: [letter], since: Date.now() })
    this.timer ??= setInterval(() => void this.flush(), FLUSH_MS)
    return 'queued'
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.queues.clear()
  }

  /** Доставить сейчас, если можно; null — пока нельзя (ждём канал или пустое поле ввода). */
  private async tryNow(nodeId: string, letter: AgentLetter, waitedMs: number): Promise<LetterRoute | null> {
    const { deps } = this
    if (deps.usesChannel(nodeId)) {
      if (deps.hasStream(nodeId) && deps.push(nodeId, channelMessage(letter)) > 0) return 'channel'
      if (waitedMs < CHANNEL_WAIT_MS) return null
    }
    try {
      if (await deps.deliver(nodeId, letter)) return 'agent'
    } catch {
      // Свой способ сломался — доставим как раньше.
    }
    if (await this.hasDraft(nodeId, waitedMs)) return null
    deps.write(nodeId, `\x1b[200~${letter.text}\x1b[201~`)
    await deps.sleep(PASTE_SETTLE_MS)
    deps.write(nodeId, '\r')
    return 'terminal'
  }

  private async hasDraft(nodeId: string, waitedMs: number): Promise<boolean> {
    const typing = this.deps.humanTyping(nodeId)
    const screen = await this.deps.readScreen(nodeId).catch(() => null)
    const draft = screen === null ? undefined : this.deps.inputDraft(nodeId, screen)
    if (typeof draft === 'string') {
      // Экран — правда: стёр Backspace-ами — пусто, вставил мышью — черновик.
      return draft !== '' && (typing.idleMs < SCREEN_ABANDON_MS || waitedMs < SCREEN_ABANDON_MS)
    }
    return typing.draft && typing.idleMs < TYPING_ABANDON_MS
  }

  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const [nodeId, queue] of [...this.queues]) {
        if (!this.deps.isRunning(nodeId)) {
          this.queues.delete(nodeId)
          continue
        }
        while (queue.letters.length > 0) {
          const next = queue.letters[0] as AgentLetter
          const route = await this.tryNow(nodeId, next, Date.now() - queue.since)
          if (!route) break
          queue.letters.shift()
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
