import type { CanvasDoc, DocNode } from './document'
import { isAgent } from './terminal'

/**
 * Таймер — кружок, который раз в `every` минут шлёт письмо агентам, соединённым с ним
 * связью (в любую сторону). Хранится в текстовой ноде с пометкой `x-cnv.timer` —
 * Obsidian покажет карточку.
 *
 * Тики считаются от `since`: N-й — в `since + N·every`. Так время следующего тика не
 * пишется в файл на каждом тике, а пропущенные, пока cnv был закрыт, просто не шлются.
 */
export interface TimerSpec {
  /** Интервал, минуты. */
  every: number
  /** Что прислать агентам. */
  message: string
  /** Отсчёт тиков, мс. Сбрасывается сменой интервала и снятием с паузы. */
  since: number
  paused?: boolean
}

export const TIMER_SIZE = { width: 160, height: 200 } as const
export const TIMER_MIN_EVERY = 1
/** Неделя: дальше это уже не таймер, а календарь. */
export const TIMER_MAX_EVERY = 7 * 24 * 60
export const TIMER_DEFAULT_EVERY = 15

const KEY = 'x-cnv'
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

export function timerSpec(node: DocNode): TimerSpec | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  const t = isRecord(own) ? own.timer : undefined
  if (!isRecord(t) || typeof t.every !== 'number' || !Number.isFinite(t.every)) return null
  return {
    every: clampEvery(t.every),
    message: typeof t.message === 'string' ? t.message : '',
    since: typeof t.since === 'number' && Number.isFinite(t.since) ? t.since : 0,
    ...(t.paused === true ? { paused: true } : {})
  }
}

export const isTimer = (node: DocNode): boolean => timerSpec(node) !== null

export function withTimerSpec(
  extra: Record<string, unknown>,
  spec: Partial<TimerSpec>
): Record<string, unknown> {
  const own = isRecord(extra[KEY]) ? (extra[KEY] as Record<string, unknown>) : {}
  const prev = isRecord(own.timer) ? own.timer : {}
  const next: Record<string, unknown> = { ...prev, ...spec }
  if (!next.paused) delete next.paused
  return { ...extra, [KEY]: { ...own, timer: next } }
}

export const clampEvery = (minutes: number): number =>
  Math.min(TIMER_MAX_EVERY, Math.max(TIMER_MIN_EVERY, Math.round(minutes)))

/** Текст карточки — то, что увидит Obsidian, открыв наш канвас. */
export const timerPlaceholder = (every: number): string => `\`таймер · каждые ${formatEvery(every)}\``

/** «15 мин», «2 ч», «1 ч 30 мин». */
export function formatEvery(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m} мин`
  return m ? `${h} ч ${m} мин` : `${h} ч`
}

const periodMs = (spec: TimerSpec): number => spec.every * 60_000

/** Номер последнего наступившего тика (0 — ещё ни одного). */
export const timerSlot = (spec: TimerSpec, now: number): number =>
  Math.max(0, Math.floor((now - spec.since) / periodMs(spec)))

/** Сколько осталось до следующего тика, мс. */
export function timerLeftMs(spec: TimerSpec, now: number): number {
  const period = periodMs(spec)
  const passed = now - spec.since
  // Отсчёт из будущего (часы «сейчас» отстали от свежего since) — впереди целый интервал.
  if (passed < 0) return period
  return period - (passed % period)
}

/** «4:07», «1:02:03». */
export function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Кому таймер шлёт: агенты, соединённые с ним связью в любую сторону. */
export function timerTargets(doc: CanvasDoc, timerId: string): string[] {
  const linked = new Set(
    doc.edges.flatMap((e) => (e.fromNode === timerId ? [e.toNode] : e.toNode === timerId ? [e.fromNode] : []))
  )
  return doc.nodes.filter((n) => linked.has(n.id) && isAgent(n)).map((n) => n.id)
}
