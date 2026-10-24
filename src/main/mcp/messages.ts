import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Почта агентов: каждое `agent_send` — письмо с id. Текст уходит адресату, а само письмо
 * хранится здесь и в файле рядом с данными cnv: по нему отвечают (`reply_to`), его ждут
 * (`wait_reply`) и перечитывают (`inbox`) — и после перезапуска cnv тоже.
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
  /** Какие ответы на письмо уже отданы через wait_reply: второй раз ждём уже следующий. */
  private handed = new Map<string, Set<string>>()

  /** `file` — журнал писем (JSON Lines): без него почта живёт, пока жив cnv. */
  constructor(private readonly file?: string) {
    if (!file) return
    try {
      this.messages = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AgentMessage)
        .slice(-MAX_KEPT)
    } catch {
      // Журнала ещё нет или он битый — начинаем с пустой почты.
    }
  }

  newId(): string {
    return `m${crypto.randomBytes(4).toString('hex')}`
  }

  post(message: AgentMessage): AgentMessage {
    this.messages.push(message)
    if (this.messages.length > MAX_KEPT) this.messages.splice(0, this.messages.length - MAX_KEPT)
    this.save(message)
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

  /**
   * Письма ноды — новые в конце: входящие, а с `sent` — и отправленные. `after` — только
   * после письма с этим id.
   */
  inbox(node: string, after?: string, sent = false): AgentMessage[] {
    const mine = this.messages.filter((m) => m.to === node || (sent && m.from === node))
    if (!after) return mine
    const i = mine.findIndex((m) => m.id === after)
    return i < 0 ? mine : mine.slice(i + 1)
  }

  /** Переписка вокруг письма: вверх по `reply_to` до начала и все ответы ниже — по времени. */
  thread(id: string): AgentMessage[] {
    let root = this.get(id)
    const seen = new Set<string>()
    while (root?.replyTo && !seen.has(root.id)) {
      seen.add(root.id)
      const up = this.get(root.replyTo)
      if (!up) break
      root = up
    }
    if (!root) return []
    const out = new Set<AgentMessage>([root])
    for (let grew = true; grew;) {
      grew = false
      for (const m of this.messages) {
        if (!out.has(m) && m.replyTo && [...out].some((o) => o.id === m.replyTo)) {
          out.add(m)
          grew = true
        }
      }
    }
    return [...out].sort((a, b) => a.at - b.at)
  }

  /**
   * Ответ на любое из писем: от его адресата его отправителю — с `reply_to` или просто
   * позже. Ответ, который уже отдавали, второй раз не отдаём — ждём следующий.
   */
  waitReply(originals: AgentMessage | AgentMessage[], timeoutMs: number): Promise<AgentMessage | null> {
    const list = Array.isArray(originals) ? originals : [originals]
    const fits = (o: AgentMessage, m: AgentMessage): boolean =>
      m.from === o.to &&
      m.to === o.from &&
      !this.handed.get(o.id)?.has(m.id) &&
      (m.replyTo === o.id || (m.replyTo === undefined && m.at > o.at))
    const hand = (m: AgentMessage): AgentMessage => {
      for (const o of list) {
        if (!fits(o, m)) continue
        const set = this.handed.get(o.id) ?? new Set<string>()
        set.add(m.id)
        this.handed.set(o.id, set)
      }
      return m
    }
    const match = (m: AgentMessage): boolean => list.some((o) => fits(o, m))
    const since = Math.min(...list.map((o) => o.at))
    const already = this.messages.find((m) => m.at >= since && !list.includes(m) && match(m))
    if (already) return Promise.resolve(hand(already))
    return new Promise((resolve) => {
      const waiter = { match, resolve: (m: AgentMessage) => resolve(hand(m)) }
      this.waiters.add(waiter)
      setTimeout(() => {
        if (this.waiters.delete(waiter)) resolve(null)
      }, timeoutMs)
    })
  }

  private save(message: AgentMessage): void {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.appendFileSync(this.file, `${JSON.stringify(message)}\n`, { mode: 0o600 })
      // Журнал растёт — раз в много писем переписываем его хвостом, что держим в памяти.
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) {
        fs.writeFileSync(this.file, this.messages.map((m) => JSON.stringify(m)).join('\n') + '\n', {
          mode: 0o600
        })
      }
    } catch {
      // Не записалось — почта всё равно работает в памяти.
    }
  }
}
