import { describe, expect, it } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeEdge, makeNode } from '@core/ops'
import { edgeNotices } from '@core/edge-notices'

const rect = { x: 0, y: 0, width: 10, height: 10 }
const agent = (name: string): ReturnType<typeof makeNode> =>
  makeNode({ type: 'terminal', shell: 'sh', name, agent: { sessionId: '' } }, rect)
const doc = (nodes: CanvasDoc['nodes'], edges: CanvasDoc['edges'] = []): CanvasDoc => ({
  nodes,
  edges,
  extra: {}
})

describe('агентам — что поменялось в связях и цветах', () => {
  it('новая и пропавшая связь — обоим концам, со стороной стрелки и подписью', () => {
    const a = agent('Даня')
    const b = agent('Лиза')
    const edge = { ...makeEdge(a.id, b.id), label: 'ревьюит' }
    const added = edgeNotices(doc([a, b]), doc([a, b], [edge]))
    expect(added.map((n) => n.nodeId).sort()).toEqual([a.id, b.id].sort())
    expect(added.find((n) => n.nodeId === a.id)?.text).toBe(
      `+ стрелка от тебя к: агент «Лиза» (id ${b.id}), подпись «ревьюит»`
    )
    expect(added.find((n) => n.nodeId === b.id)?.text).toContain('+ стрелка к тебе от: агент «Даня»')
    const removed = edgeNotices(doc([a, b], [edge]), doc([a, b]))
    expect(removed.find((n) => n.nodeId === a.id)?.text).toMatch(/^− стрелка от тебя к: агент «Лиза»/)
  })

  it('цвет связи, соседа и своей карточки; карточке без агента писать некому', () => {
    const a = agent('Даня')
    const card = makeNode({ type: 'text', text: 'План работ' }, rect)
    const edge = makeEdge(card.id, a.id)
    const after = doc([{ ...a, color: '4' }, { ...card, color: '1' }], [{ ...edge, color: '5' }])
    const [notice, ...rest] = edgeNotices(doc([a, card], [edge]), after)
    expect(rest).toEqual([])
    expect(notice?.text.split('\n')).toEqual([
      '~ твоя карточка: цвет без цвета → зелёный',
      `~ стрелка к тебе от: карточка «План работ» (id ${card.id}): цвет без цвета → голубой`,
      `~ сосед карточка «План работ» (id ${card.id}): цвет без цвета → красный`
    ])
  })

  it('кто правил сам — тому не пишем; без перемен — тишина', () => {
    const a = agent('Даня')
    const b = agent('Лиза')
    const notices = edgeNotices(doc([a, b]), doc([a, b], [makeEdge(a.id, b.id)]), new Set([a.id]))
    expect(notices.map((n) => n.nodeId)).toEqual([b.id])
    expect(edgeNotices(doc([a, b]), doc([{ ...a, x: 50 }, b]))).toEqual([])
  })
})
