import { describe, expect, it } from 'vitest'
import { edgeCrossings, findOverlaps, layoutRects, type LayoutItem } from '@core/layout'
import { rectsIntersect } from '@core/geometry'

const item = (id: string, x: number, y: number, width = 100, height = 50): LayoutItem => ({
  id,
  rect: { x, y, width, height }
})

const noOverlaps = (rects: Map<string, { x: number; y: number; width: number; height: number }>): boolean => {
  const list = [...rects.values()]
  return list.every((a, i) => list.slice(i + 1).every((b) => !rectsIntersect(a, b)))
}

describe('раскладки', () => {
  const items = [
    item('a', 0, 0),
    item('b', 500, 0),
    item('c', 0, 300),
    item('d', 500, 300),
    item('e', 900, 900)
  ]

  it('сетка: квадратная, в порядке чтения, без наложений', () => {
    const r = layoutRects(items, [], { mode: 'grid', gap: 20 })
    expect(r.get('a')).toMatchObject({ x: 0, y: 0 })
    expect(r.get('b')).toMatchObject({ x: 120, y: 0 })
    expect(r.get('c')).toMatchObject({ x: 240, y: 0 })
    expect(r.get('d')).toMatchObject({ x: 0, y: 70 })
    expect(noOverlaps(r)).toBe(true)
  })

  it('ряд и столбец', () => {
    const row = layoutRects(items.slice(0, 3), [], { mode: 'row', gap: 10, origin: { x: 0, y: 0 } })
    expect(['a', 'c', 'b'].map((id) => row.get(id)!.x)).toEqual([0, 110, 220])
    const col = layoutRects(items.slice(0, 2), [], { mode: 'column', gap: 10 })
    expect(col.get('b')).toMatchObject({ x: 0, y: 60 })
  })

  it('круг: корень на месте, остальные вокруг, без наложений', () => {
    const r = layoutRects(items, [], { mode: 'radial', gap: 20, root: 'e' })
    expect(r.get('e')).toEqual(items[4]!.rect)
    expect(noOverlaps(r)).toBe(true)
  })

  it('дерево по связям: уровни слева направо, родитель посередине детей', () => {
    const edges = [
      { fromNode: 'a', toNode: 'b' },
      { fromNode: 'a', toNode: 'c' },
      { fromNode: 'b', toNode: 'd' }
    ]
    const r = layoutRects(items.slice(0, 4), edges, { mode: 'tree', gap: 20, origin: { x: 0, y: 0 } })
    expect(r.get('a')!.x).toBe(0)
    expect(r.get('b')!.x).toBe(r.get('c')!.x)
    expect(r.get('d')!.x).toBeGreaterThan(r.get('b')!.x)
    const center = (id: string): number => r.get(id)!.y + r.get(id)!.height / 2
    expect(center('a')).toBe((center('b') + center('c')) / 2)
    expect(noOverlaps(r)).toBe(true)
  })

  it('цикл в связях не вешает дерево', () => {
    const edges = [
      { fromNode: 'a', toNode: 'b' },
      { fromNode: 'b', toNode: 'a' }
    ]
    expect(layoutRects(items.slice(0, 2), edges, { mode: 'tree', gap: 10 }).size).toBe(2)
  })
})

describe('наложения', () => {
  it('ноды налезают — пара; группы не считаются', () => {
    const nodes = [
      { id: 'g', kind: 'group', rect: { x: 0, y: 0, width: 500, height: 500 } },
      { id: 'a', kind: 'text', rect: { x: 10, y: 10, width: 100, height: 50 } },
      { id: 'b', kind: 'text', rect: { x: 50, y: 30, width: 100, height: 50 } },
      { id: 'c', kind: 'text', rect: { x: 300, y: 300, width: 100, height: 50 } }
    ]
    expect(findOverlaps(nodes)).toEqual([['a', 'b']])
  })

  it('стрелка сквозь чужую ноду', () => {
    const nodes = [
      { id: 'a', kind: 'text', rect: { x: 0, y: 0, width: 100, height: 50 } },
      { id: 'm', kind: 'text', rect: { x: 200, y: 0, width: 100, height: 50 } },
      { id: 'b', kind: 'text', rect: { x: 400, y: 0, width: 100, height: 50 } }
    ]
    expect(edgeCrossings(nodes, [{ id: 'e', fromNode: 'a', toNode: 'b' }])).toEqual([
      { edge: 'e', nodes: ['m'] }
    ])
  })
})
