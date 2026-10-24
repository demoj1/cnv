import { describe, expect, it } from 'vitest'
import { DocStore, HUMAN } from '@core/doc-store'
import { EMPTY_DOC } from '@core/document'
import { deleteEntities, insertEdges, insertNodes, makeEdge, makeNode } from '@core/ops'

const rect = { x: 0, y: 0, width: 10, height: 10 }

describe('журнал правок', () => {
  it('кто, что, когда — и отмена агентом тоже пишется на агента', () => {
    const store = new DocStore()
    store.load(EMPTY_DOC)
    const a = makeNode({ type: 'text', text: 'a' }, rect)
    const b = makeNode({ type: 'text', text: 'b' }, rect)
    const edge = makeEdge(a.id, b.id)
    store.mutate('карточки', (d) => insertEdges(insertNodes(d, [a, b]), [edge]))
    store.mutate('агент: удаление', (d) => deleteEntities(d, new Set([a.id]), new Set()), 'Олег (n1)')
    store.asActor('Прасковья (n2)', () => store.undo())

    const [add, del, undo] = store.journal
    expect(add).toMatchObject({
      actor: HUMAN,
      kind: 'edit',
      nodes: { added: [a.id, b.id] },
      edges: { added: [edge.id] }
    })
    expect(del).toMatchObject({
      actor: 'Олег (n1)',
      nodes: { removed: [a.id] },
      edges: { removed: [edge.id] }
    })
    // Отмена удаления — это добавление, и сделала её Прасковья.
    expect(undo).toMatchObject({ actor: 'Прасковья (n2)', kind: 'undo', nodes: { added: [a.id] } })
    expect(store.journal.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('удалённая нода лежит на кладбище со связями и автором', () => {
    const store = new DocStore()
    store.load(EMPTY_DOC)
    const a = makeNode({ type: 'text', text: 'a' }, rect)
    const b = makeNode({ type: 'text', text: 'b' }, rect)
    const edge = makeEdge(a.id, b.id)
    store.mutate('карточки', (d) => insertEdges(insertNodes(d, [a, b]), [edge]))
    store.mutate('удаление', (d) => deleteEntities(d, new Set([a.id]), new Set()), 'Олег (n1)')
    expect(store.tombstone(a.id)).toMatchObject({
      node: { id: a.id },
      edges: [{ id: edge.id }],
      actor: 'Олег (n1)'
    })
    expect(store.tombstone(b.id)).toBeUndefined()
  })
})
