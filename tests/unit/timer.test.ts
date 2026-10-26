import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeEdge, makeNode } from '@core/ops'
import { applyNodePatch, buildNode, toAgentNode } from '@core/agent-ops'
import { nodeKind } from '@core/node-kind'
import { formatLeft, timerLeftMs, timerSlot, timerSpec, timerTargets } from '@core/timer'
import { TIMER_IDLE_MS, TimerQueue } from '../../src/main/mcp/timers'
import type { TimerTick } from '@shared/api'

const rect = { x: 0, y: 0, width: 10, height: 10 }
const MIN = 60_000
const timer = (every = 15, since = 0): ReturnType<typeof makeNode> =>
  makeNode({ type: 'timer', every, message: 'проверь CI', since }, rect)
const doc = (nodes: CanvasDoc['nodes'], edges: CanvasDoc['edges'] = []): CanvasDoc => ({
  nodes,
  edges,
  extra: {}
})

afterEach(() => {
  vi.useRealTimers()
})

describe('таймер', () => {
  it('тики считаются от since: номер, остаток, формат', () => {
    const spec = timerSpec(timer(15, 1000))!
    expect(timerSlot(spec, 1000)).toBe(0)
    expect(timerSlot(spec, 1000 + 15 * MIN - 1)).toBe(0)
    expect(timerSlot(spec, 1000 + 15 * MIN)).toBe(1)
    expect(timerLeftMs(spec, 1000 + 3 * MIN)).toBe(12 * MIN)
    expect(formatLeft(12 * MIN)).toBe('12:00')
    expect(formatLeft(61 * MIN + 5000)).toBe('1:01:05')
  })

  it('адресаты — агенты по связям в любую сторону; терминал и карточка — нет', () => {
    const t = timer()
    const a = makeNode({ type: 'terminal', shell: 'sh', name: 'Даня', agent: { sessionId: '' } }, rect)
    const b = makeNode({ type: 'terminal', shell: 'sh', name: 'Лиза', agent: { sessionId: '' } }, rect)
    const term = makeNode({ type: 'terminal', shell: 'sh', name: 'Терминал 1' }, rect)
    const lonely = makeNode({ type: 'terminal', shell: 'sh', name: 'Олег', agent: { sessionId: '' } }, rect)
    const d = doc(
      [t, a, b, term, lonely],
      [makeEdge(t.id, a.id), makeEdge(b.id, t.id), makeEdge(t.id, term.id)]
    )
    expect(timerTargets(d, t.id).sort()).toEqual([a.id, b.id].sort())
    expect(nodeKind(t)).toBe('timer')
  })

  it('агент видит интервал и текст; смена интервала и снятие паузы — отсчёт заново', () => {
    vi.useFakeTimers({ now: 10 * MIN })
    const t = timer(15, 0)
    expect(toAgentNode(t)).toMatchObject({ kind: 'timer', every: 15, message: 'проверь CI' })
    let d = applyNodePatch(doc([t]), t.id, { message: 'новое' })
    expect(timerSpec(d.nodes[0]!)).toMatchObject({ every: 15, message: 'новое', since: 0 })
    d = applyNodePatch(d, t.id, { every: 5 })
    expect(timerSpec(d.nodes[0]!)).toMatchObject({ every: 5, since: 10 * MIN })
    expect(d.nodes[0]).toMatchObject({ text: '`таймер · каждые 5 мин`' })
    vi.setSystemTime(20 * MIN)
    d = applyNodePatch(d, t.id, { paused: true })
    expect(timerSpec(d.nodes[0]!)).toMatchObject({ paused: true, since: 10 * MIN })
    d = applyNodePatch(d, t.id, { paused: false })
    expect(timerSpec(d.nodes[0]!)).toEqual({ every: 5, message: 'новое', since: 20 * MIN })
    expect(() => applyNodePatch(d, t.id, { every: 0.5 })).toThrow(/от 1/)
    expect(() => applyNodePatch(d, t.id, { text: 'x' })).toThrow(/message/)
    const card = makeNode({ type: 'text', text: 'x' }, rect)
    expect(() => applyNodePatch(doc([card]), card.id, { every: 5 })).toThrow(/не таймер/)
  })

  it('агент создаёт таймер: интервал проверяется', () => {
    const opts = { shell: 'sh', defaultAgent: 'claude' }
    const t = buildNode(doc([]), { kind: 'timer', every: 3, message: 'пинг' }, rect, opts)
    expect(timerSpec(t)).toMatchObject({ every: 3, message: 'пинг' })
    expect(() => buildNode(doc([]), { kind: 'timer', every: 0, message: 'x' }, rect, opts)).toThrow()
  })
})

describe('очередь тиков: письмо — когда агент свободен', () => {
  const tick = (message: string, targets = ['a']): TimerTick => ({ timerId: 't', every: 1, message, targets })

  it('свободному — сразу, занятому — когда притихнет, и только последний тик', () => {
    vi.useFakeTimers()
    const idle: Record<string, number | null> = { a: TIMER_IDLE_MS, b: 0 }
    const got: [string, string][] = []
    const q = new TimerQueue({
      idleMs: (id) => idle[id] ?? null,
      deliver: (id, t) => got.push([id, t.message])
    })
    q.fire(tick('1', ['a', 'b']))
    expect(got).toEqual([['a', '1']])
    q.fire(tick('2', ['b']))
    vi.advanceTimersByTime(5000)
    expect(got).toEqual([['a', '1']])
    idle.b = TIMER_IDLE_MS
    vi.advanceTimersByTime(1000)
    expect(got).toEqual([
      ['a', '1'],
      ['b', '2']
    ])
    expect(q.size).toBe(0)
  })

  it('агента больше нет — тик выбрасываем', () => {
    const got: string[] = []
    const q = new TimerQueue({ idleMs: () => null, deliver: (id) => got.push(id) })
    q.fire(tick('x'))
    expect(got).toEqual([])
    expect(q.size).toBe(0)
  })
})
