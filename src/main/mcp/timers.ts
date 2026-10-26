import type { TimerTick } from '@shared/api'

/**
 * Тики таймеров ждут, пока агент освободится: письмо в разгар работы сбивает его с
 * задачи, а пачка одинаковых писем после долгой работы — шум. Поэтому от каждого таймера
 * каждому агенту держим только последний тик и отдаём его, когда терминал притих.
 */

/** Агент свободен, если его терминал молчит столько. */
export const TIMER_IDLE_MS = 3000
const POLL_MS = 1000

export interface TimerQueueDeps {
  /** Сколько терминал молчит, мс; `null` — терминала нет. */
  idleMs(nodeId: string): number | null
  deliver(nodeId: string, tick: TimerTick): void
}

export class TimerQueue {
  /** `таймер:агент` → тик, который ещё не отдали. */
  private readonly pending = new Map<string, { target: string; tick: TimerTick }>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: TimerQueueDeps) {}

  fire(tick: TimerTick): void {
    for (const target of tick.targets) this.pending.set(`${tick.timerId}:${target}`, { target, tick })
    this.flush()
  }

  /** Отдать тики свободным агентам; ушедшим — выбросить. */
  flush(): void {
    for (const [key, { target, tick }] of this.pending) {
      const idle = this.deps.idleMs(target)
      if (idle === null) this.pending.delete(key)
      else if (idle >= TIMER_IDLE_MS) {
        this.pending.delete(key)
        this.deps.deliver(target, tick)
      }
    }
    if (this.pending.size && !this.timer) this.timer = setInterval(() => this.flush(), POLL_MS)
    if (!this.pending.size && this.timer) this.stop()
  }

  get size(): number {
    return this.pending.size
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
