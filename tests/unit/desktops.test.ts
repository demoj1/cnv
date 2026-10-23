import { describe, expect, it } from 'vitest'
import { placeRect } from '@core/agent-ops'
import type { CanvasDoc, DocNode } from '@core/document'
import {
  DESKTOP_SPAN,
  desktopAtX,
  desktopKey,
  desktopOfNode,
  desktopOrigin,
  desktopSummary,
  moveToDesktop
} from '@core/desktops'
import { makeNode } from '@core/ops'

const card = (id: string, x: number): DocNode => ({
  ...makeNode({ type: 'text', text: id }, { x, y: 0, width: 100, height: 100 }),
  id
})
const doc = (...nodes: DocNode[]): CanvasDoc => ({ nodes, edges: [], extra: {} })

describe('рабочие столы', () => {
  it('стол определяется по центру ноды, края зажаты', () => {
    expect(desktopAtX(0)).toBe(1)
    expect(desktopAtX(-1e9)).toBe(1)
    expect(desktopAtX(DESKTOP_SPAN)).toBe(2)
    expect(desktopAtX(DESKTOP_SPAN * 9)).toBe(10)
    expect(desktopAtX(1e12)).toBe(10)
    expect(desktopOfNode(card('a', desktopOrigin(3).x - 50))).toBe(3)
  })

  it('Alt+0 — десятый стол', () => {
    expect(desktopKey(10)).toBe('0')
    expect(desktopKey(4)).toBe('4')
  })

  it('перенос сохраняет положение относительно стола, чужие не трогает', () => {
    const d = doc(card('a', 10), card('b', 500))
    const moved = moveToDesktop(d, ['a'], 4)
    expect(moved.nodes[0]!.x).toBe(10 + 3 * DESKTOP_SPAN)
    expect(moved.nodes[1]).toBe(d.nodes[1])
    expect(moveToDesktop(moved, ['a'], 4)).toBe(moved)
  })

  it('сводка по столам', () => {
    const summary = desktopSummary(doc(card('a', 0), card('b', DESKTOP_SPAN * 2)))
    expect(summary[0]).toEqual({ desktop: 1, nodes: 1 })
    expect(summary[2]).toEqual({ desktop: 3, nodes: 1 })
    expect(summary).toHaveLength(10)
  })

  it('нода на другой стол встаёт в его вид, якорь с чужого стола игнорируется', () => {
    const anchor = card('me', 0)
    const view5 = { x: desktopOrigin(5).x - 500, y: -300, width: 1000, height: 600 }
    const rect = placeRect(
      doc(anchor),
      { near: 'me', desktop: 5 },
      { width: 100, height: 100 },
      { x: 0, y: 0, width: 10, height: 10 },
      (d) => (d === 5 ? view5 : { x: 0, y: 0, width: 0, height: 0 })
    )
    expect(desktopOfNode({ ...anchor, ...rect })).toBe(5)
    const near = placeRect(doc(anchor), { near: 'me', desktop: 1 }, { width: 50, height: 50 }, view5)
    expect(near.x).toBe(140)
  })
})
