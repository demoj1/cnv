import crypto from 'node:crypto'

/**
 * Почта агентов: каждое `agent_send` — письмо с id. Текст уходит в терминал адресата, а
 * само письмо хранится здесь (пока cnv запущен): по нему отвечают (`reply_to`), его ждут
 * (`wait_reply`) и перечитывают (`inbox`) — даже если в терминале его уже прокрутили.
 */
export interface AgentMessage {
  id: string
  /** id ноды отправителя; null — внешний клиент. */
  from: string | null
  fromName: string | null
  to: string
  text: string
  replyTo?: string
  /** Вложения — файлы на диске: JSON с данными или переданные файлы. */
  attachments: { path: string; kind: 'json' | 'file'; bytes: number }[]
  at: number
}

const MAX_KEPT = 2000

export class MessageBox {
  private messages: AgentMessage[] = []
  private waiters = new Set<{ match(m: AgentMessage): boolean; resolve(m: AgentMessage): void }>()

  newId(): string {
    return `m${crypto.randomBytes(4).toString('hex')}`
  }

  post(message: AgentMessage): AgentMessage {
    this.messages.push(message)
    if (this.messages.length > MAX_KEPT) this.messages.splice(0, this.messages.length - MAX_KEPT)
    for (const w of [...this.waiters]) {
      if (w.match(message)) {
        this.waiters.delete(w)
        w.resolve(message)
      }
    }
    return message
  }

  get(id: string): AgentMessage | undefined {
    return this.messages.find((m) => m.id === id)
  }

  /** Письма адресату — новые в конце. `after` — только после письма с этим id. */
  inbox(to: string, after?: string): AgentMessage[] {
    const mine = this.messages.filter((m) => m.to === to)
    if (!after) return mine
    const i = mine.findIndex((m) => m.id === after)
    return i < 0 ? mine : mine.slice(i + 1)
  }

  /** Ответ на письмо: от его адресата его отправителю — с `reply_to` или просто позже. */
  waitReply(original: AgentMessage, timeoutMs: number): Promise<AgentMessage | null> {
    const match = (m: AgentMessage): boolean =>
      m.from === original.to &&
      m.to === original.from &&
      (m.replyTo === original.id || (m.replyTo === undefined && m.at > original.at))
    const already = this.messages.find((m) => m.at >= original.at && m !== original && match(m))
    if (already) return Promise.resolve(already)
    return new Promise((resolve) => {
      const waiter = { match, resolve: (m: AgentMessage | null) => resolve(m) }
      this.waiters.add(waiter)
      setTimeout(() => {
        if (this.waiters.delete(waiter)) resolve(null)
      }, timeoutMs)
    })
  }
}
