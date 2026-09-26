import { describe, expect, it } from 'vitest'
import type { CanvasDoc, DocNode } from '@core/document'
import { fragmentFromSelection, looksLikeUrl, normalizeUrl, pasteFragment } from '@core/clipboard'
import { makeEdge } from '@core/ops'

function text(id: string, x: number, y: number): DocNode {
  return { id, type: 'text', text: id, x, y, width: 100, height: 60, extra: {} }
}

const doc = (nodes: DocNode[], edges: CanvasDoc['edges'] = []): CanvasDoc => ({ nodes, edges, extra: {} })

describe('фрагмент из выделения', () => {
  const base = doc(
    [text('a', 0, 0), text('b', 200, 0), text('c', 400, 0)],
    [makeEdge('a', 'b'), makeEdge('b', 'c')]
  )

  it('берёт выделенные ноды и только внутренние рёбра', () => {
    const fragment = fragmentFromSelection(base, new Set(['a', 'b']))
    expect(fragment.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(fragment.edges).toHaveLength(1)
  })

  it('пустое выделение даёт пустой фрагмент', () => {
    const fragment = fragmentFromSelection(base, new Set())
    expect(fragment.nodes).toHaveLength(0)
    expect(fragment.edges).toHaveLength(0)
  })
})

describe('вставка фрагмента', () => {
  const fragment = doc([text('a', 100, 100), text('b', 300, 160)], [makeEdge('a', 'b')])

  it('кладёт левый верхний угол фрагмента в заданную точку', () => {
    const { doc: next, newNodeIds } = pasteFragment(doc([]), fragment, { x: 0, y: 0 })
    expect(newNodeIds).toHaveLength(2)
    expect(next.nodes.map((n) => ({ x: n.x, y: n.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 60 }
    ])
  })

  it('выдаёт новые id и сохраняет рёбра между скопированными нодами', () => {
    const { doc: next } = pasteFragment(doc([text('старая', 0, 0)]), fragment, { x: 500, y: 500 })
    expect(next.nodes).toHaveLength(3)
    expect(next.nodes.map((n) => n.id)).not.toContain('a')
    expect(next.edges).toHaveLength(1)
    const edge = next.edges[0]
    expect(next.nodes.some((n) => n.id === edge?.fromNode)).toBe(true)
    expect(next.nodes.some((n) => n.id === edge?.toNode)).toBe(true)
  })

  it('вставка дважды даёт разные id', () => {
    const first = pasteFragment(doc([]), fragment, { x: 0, y: 0 })
    const second = pasteFragment(first.doc, fragment, { x: 0, y: 0 })
    expect(new Set([...first.newNodeIds, ...second.newNodeIds]).size).toBe(4)
  })

  it('пустой фрагмент ничего не меняет', () => {
    const base = doc([text('a', 0, 0)])
    expect(pasteFragment(base, doc([]), { x: 0, y: 0 }).doc).toBe(base)
  })

  it('копия не делит extra с оригиналом', () => {
    const original = text('a', 0, 0)
    original.extra.meta = 1
    const { doc: next } = pasteFragment(doc([]), doc([original]), { x: 0, y: 0 })
    expect(next.nodes[0]?.extra).not.toBe(original.extra)
    expect(next.nodes[0]?.extra.meta).toBe(1)
  })
})

describe('распознавание ссылок', () => {
  it('одиночный адрес — ссылка', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true)
    expect(looksLikeUrl('  http://example.com/x?y=1  ')).toBe(true)
    expect(looksLikeUrl('www.example.com')).toBe(true)
  })

  it('текст со ссылкой внутри ссылкой не считается', () => {
    expect(looksLikeUrl('смотри https://example.com тут')).toBe(false)
    expect(looksLikeUrl('просто текст')).toBe(false)
    expect(looksLikeUrl('')).toBe(false)
    expect(looksLikeUrl('ftp://example.com')).toBe(false)
  })

  it('схема достраивается', () => {
    expect(normalizeUrl('www.example.com')).toBe('https://www.example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })
})
