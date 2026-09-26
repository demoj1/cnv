import { describe, expect, it } from 'vitest'
import type { CanvasDoc, DocNode } from '@core/document'
import type { Rect } from '@core/geometry'
import { nodesInsideGroup } from '@core/ops'
import {
  duplicateSubgraph,
  groupSelection,
  insertEdges,
  makeEdge,
  makeNode,
  moveNodes,
  patchEdge,
  reorderNodes,
  ungroup
} from '@core/ops'

const box = (x: number, y: number, width = 100, height = 60): Rect => ({ x, y, width, height })

function text(id: string, x: number, y: number, w = 100, h = 60): DocNode {
  return { id, type: 'text', text: id, x, y, width: w, height: h, extra: {} }
}

function group(id: string, x: number, y: number, w: number, h: number): DocNode {
  return { id, type: 'group', label: id, x, y, width: w, height: h, extra: {} }
}

const doc = (nodes: DocNode[], edges: CanvasDoc['edges'] = []): CanvasDoc => ({ nodes, edges, extra: {} })

describe('makeNode', () => {
  it('раскладывает поля по типу и не тащит лишнего', () => {
    const t = makeNode({ type: 'text', text: 'привет' }, box(1, 2))
    expect(t.type).toBe('text')
    expect(t.id).toMatch(/^[0-9a-f]{16}$/)
    expect('url' in t).toBe(false)

    const f = makeNode({ type: 'file', file: 'a/b.pdf', subpath: '#2' }, box(0, 0))
    if (f.type !== 'file') throw new Error('ожидали file')
    expect(f.file).toBe('a/b.pdf')
    expect(f.subpath).toBe('#2')

    const noSub = makeNode({ type: 'file', file: 'a.png' }, box(0, 0))
    expect('subpath' in noSub).toBe(false)
  })

  it('цвет добавляется только если передан', () => {
    expect('color' in makeNode({ type: 'text', text: '' }, box(0, 0))).toBe(false)
    expect(makeNode({ type: 'text', text: '' }, box(0, 0), '3').color).toBe('3')
  })
})

describe('z-order', () => {
  const base = doc([text('a', 0, 0), text('b', 0, 0), text('c', 0, 0), text('d', 0, 0)])
  const ids = (d: CanvasDoc): string[] => d.nodes.map((n) => n.id)

  it('на передний план и на задний', () => {
    expect(ids(reorderNodes(base, new Set(['a']), 'front'))).toEqual(['b', 'c', 'd', 'a'])
    expect(ids(reorderNodes(base, new Set(['d']), 'back'))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(reorderNodes(base, new Set(['a', 'b']), 'front'))).toEqual(['c', 'd', 'a', 'b'])
  })

  it('шаг вперёд и назад', () => {
    expect(ids(reorderNodes(base, new Set(['b']), 'forward'))).toEqual(['a', 'c', 'b', 'd'])
    expect(ids(reorderNodes(base, new Set(['c']), 'backward'))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('на краю ничего не происходит и документ не пересоздаётся', () => {
    expect(reorderNodes(base, new Set(['d']), 'forward')).toBe(base)
    expect(reorderNodes(base, new Set(['a']), 'backward')).toBe(base)
    expect(reorderNodes(base, new Set(), 'front')).toBe(base)
  })

  it('соседние выделенные не перепрыгивают друг через друга', () => {
    expect(ids(reorderNodes(base, new Set(['a', 'b']), 'forward'))).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('дублирование', () => {
  it('копирует ноды со сдвигом и новыми id', () => {
    const base = doc([text('a', 0, 0), text('b', 200, 0)])
    const { doc: next, newNodeIds } = duplicateSubgraph(base, new Set(['a']), { x: 20, y: 20 })
    expect(next.nodes).toHaveLength(3)
    expect(newNodeIds).toHaveLength(1)
    const copy = next.nodes[2]
    expect(copy?.id).not.toBe('a')
    expect(copy?.x).toBe(20)
  })

  it('переносит рёбра между скопированными нодами и выбрасывает висячие', () => {
    const base = insertEdges(doc([text('a', 0, 0), text('b', 200, 0), text('c', 400, 0)]), [
      makeEdge('a', 'b'),
      makeEdge('b', 'c')
    ])
    const { doc: next } = duplicateSubgraph(base, new Set(['a', 'b']), { x: 0, y: 300 })
    expect(next.edges).toHaveLength(3)
    const cloned = next.edges[2]
    expect(cloned?.fromNode).not.toBe('a')
    expect(next.nodes.some((n) => n.id === cloned?.fromNode)).toBe(true)
  })

  it('копия не делит extra с оригиналом', () => {
    const original = text('a', 0, 0)
    original.extra.meta = { k: 1 }
    const { doc: next } = duplicateSubgraph(doc([original]), new Set(['a']), { x: 10, y: 10 })
    const copy = next.nodes[1]
    expect(copy?.extra).not.toBe(original.extra)
    expect(copy?.extra.meta).toBe(original.extra.meta)
  })

  it('пустое выделение — тот же документ', () => {
    const base = doc([text('a', 0, 0)])
    expect(duplicateSubgraph(base, new Set(), { x: 1, y: 1 }).doc).toBe(base)
  })
})

describe('группы', () => {
  it('группа строится по bounds с отступом и ложится под ноды', () => {
    const base = doc([text('a', 0, 0, 100, 100), text('b', 300, 200, 100, 100)])
    const result = groupSelection(base, new Set(['a', 'b']), 20, 'Группа', { width: 40, height: 40 })
    if (!result) throw new Error('группа не создалась')
    const g = result.doc.nodes[0]
    expect(g?.type).toBe('group')
    expect({ x: g?.x, y: g?.y, width: g?.width, height: g?.height }).toEqual({
      x: -20,
      y: -20,
      width: 440,
      height: 340
    })
  })

  it('группа не меньше минимального размера', () => {
    const base = doc([text('a', 0, 0, 5, 5)])
    const result = groupSelection(base, new Set(['a']), 0, 'г', { width: 80, height: 80 })
    expect(result?.doc.nodes[0]?.width).toBe(80)
  })

  it('пустое выделение группы не даёт', () => {
    expect(groupSelection(doc([text('a', 0, 0)]), new Set(), 10, 'г', { width: 1, height: 1 })).toBeNull()
  })

  it('разгруппировка убирает только группы', () => {
    const base = doc([group('g', 0, 0, 500, 500), text('a', 10, 10)])
    const next = ungroup(base, new Set(['g', 'a']))
    expect(next.nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('группа тащит только целиком вложенные ноды', () => {
    const base = doc([
      group('g', 0, 0, 300, 300),
      text('inside', 20, 20, 50, 50),
      text('half', 280, 20, 100, 50),
      text('outside', 500, 500, 50, 50)
    ])
    expect(nodesInsideGroup(base, 'g')).toEqual(['inside'])
  })
})

describe('мелочи', () => {
  it('moveNodes с нулевым сдвигом возвращает тот же документ', () => {
    const base = doc([text('a', 0, 0)])
    expect(moveNodes(base, new Set(['a']), { x: 0, y: 0 })).toBe(base)
    expect(moveNodes(base, new Set(), { x: 5, y: 5 })).toBe(base)
  })

  it('patchEdge правит нужное ребро и не трогает остальные', () => {
    const base = insertEdges(doc([text('a', 0, 0), text('b', 1, 1)]), [makeEdge('a', 'b')])
    const id = base.edges[0]?.id
    if (!id) throw new Error('нет ребра')
    const next = patchEdge(base, id, { label: 'подпись', color: '2' })
    expect(next.edges[0]?.label).toBe('подпись')
    expect(patchEdge(base, 'несуществующее', { label: 'x' })).toBe(base)
  })
})
