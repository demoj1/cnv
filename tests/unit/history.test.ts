import { describe, expect, it } from 'vitest'
import { DocStore } from '@core/doc-store'
import { EMPTY_DOC, type CanvasDoc, type DocNode } from '@core/document'
import { applyTransaction, diffDocs } from '@core/history'
import { deleteEntities, insertNodes, makeNode, moveNodes, patchNodes, reorderNodes } from '@core/ops'

const rect = (x: number, y: number): { x: number; y: number; width: number; height: number } => ({
  x,
  y,
  width: 100,
  height: 60
})

function docWith(...nodes: DocNode[]): CanvasDoc {
  return { nodes, edges: [], extra: {} }
}

function textNode(id: string, x: number, y: number, text = 'a'): DocNode {
  return { id, type: 'text', text, ...rect(x, y), extra: {} }
}

describe('diffDocs', () => {
  it('на идентичном документе транзакции нет', () => {
    const doc = docWith(textNode('a', 0, 0))
    expect(diffDocs(doc, doc, 'ничего')).toBeNull()
    expect(diffDocs(doc, { ...doc }, 'ничего')).toBeNull()
  })

  it('запоминает только изменившиеся поля', () => {
    const before = docWith(textNode('a', 0, 0))
    const after = moveNodes(before, new Set(['a']), { x: 10, y: 5 })
    const tx = diffDocs(before, after, 'сдвиг')
    expect(tx).not.toBeNull()
    const patch = tx?.nodes.get('a')
    expect(patch?.kind).toBe('update')
    if (patch?.kind !== 'update') throw new Error('ожидали update')
    expect(Object.keys(patch.after).sort()).toEqual(['x', 'y'])
  })

  it('различает добавление, удаление и изменение порядка', () => {
    const a = textNode('a', 0, 0)
    const b = textNode('b', 200, 0)
    const before = docWith(a, b)

    const added = diffDocs(before, insertNodes(before, [textNode('c', 400, 0)]), 'добавил')
    expect(added?.nodes.get('c')?.kind).toBe('add')

    const removed = diffDocs(before, deleteEntities(before, new Set(['b']), new Set()), 'удалил')
    expect(removed?.nodes.get('b')?.kind).toBe('remove')

    const reordered = diffDocs(before, reorderNodes(before, new Set(['a']), 'front'), 'порядок')
    expect(reordered?.nodeOrder).toEqual({ before: ['a', 'b'], after: ['b', 'a'] })
  })
})

describe('applyTransaction', () => {
  it('undo и redo возвращают документ туда и обратно', () => {
    const before = docWith(textNode('a', 0, 0), textNode('b', 200, 0))
    const after = moveNodes(before, new Set(['a', 'b']), { x: 17, y: -3 })
    const tx = diffDocs(before, after, 'сдвиг')
    if (!tx) throw new Error('нет транзакции')

    const undone = applyTransaction(after, tx, true)
    expect(undone.nodes.map((n) => ({ x: n.x, y: n.y }))).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 }
    ])

    const redone = applyTransaction(undone, tx, false)
    expect(redone.nodes.map((n) => ({ x: n.x, y: n.y }))).toEqual([
      { x: 17, y: -3 },
      { x: 217, y: -3 }
    ])
  })

  it('откат не затирает поля, которых транзакция не касалась', () => {
    const before = docWith({ id: 'w', type: 'link', url: 'https://a.example', ...rect(0, 0), extra: {} })
    const moved = moveNodes(before, new Set(['w']), { x: 50, y: 0 })
    const tx = diffDocs(before, moved, 'сдвиг')
    if (!tx) throw new Error('нет транзакции')

    // Имитация навигации внутри веб-ноды: url правится мимо истории.
    const navigated = patchNodes(moved, new Map([['w', { url: 'https://b.example' }]]))
    const undone = applyTransaction(navigated, tx, true)
    const node = undone.nodes[0]
    if (!node || node.type !== 'link') throw new Error('ожидали link-ноду')
    expect(node.x).toBe(0)
    expect(node.url).toBe('https://b.example')
  })

  it('восстанавливает удалённую ноду вместе с её местом в порядке', () => {
    const before = docWith(textNode('a', 0, 0), textNode('b', 200, 0), textNode('c', 400, 0))
    const after = deleteEntities(before, new Set(['b']), new Set())
    const tx = diffDocs(before, after, 'удалил')
    if (!tx) throw new Error('нет транзакции')
    const undone = applyTransaction(after, tx, true)
    expect(undone.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('удаление ноды уносит связанные рёбра, откат их возвращает', () => {
    const before: CanvasDoc = {
      nodes: [textNode('a', 0, 0), textNode('b', 200, 0)],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', extra: {} }],
      extra: {}
    }
    const after = deleteEntities(before, new Set(['b']), new Set())
    expect(after.edges).toHaveLength(0)
    const tx = diffDocs(before, after, 'удалил')
    if (!tx) throw new Error('нет транзакции')
    const undone = applyTransaction(after, tx, true)
    expect(undone.edges.map((e) => e.id)).toEqual(['e1'])
  })
})

describe('DocStore', () => {
  const withNodes = (): DocStore => {
    const store = new DocStore()
    store.load(docWith(textNode('a', 0, 0), textNode('b', 200, 0)))
    return store
  }

  it('загрузка сбрасывает историю и грязь', () => {
    const store = withNodes()
    expect(store.snapshot.canUndo).toBe(false)
    expect(store.snapshot.dirty).toBe(false)
  })

  it('одиночная правка вне транзакции сама себе транзакция', () => {
    const store = withNodes()
    store.mutate('сдвиг', (d) => moveNodes(d, new Set(['a']), { x: 10, y: 0 }))
    expect(store.snapshot.canUndo).toBe(true)
    expect(store.snapshot.dirty).toBe(true)
    store.undo()
    expect(store.doc.nodes[0]?.x).toBe(0)
    expect(store.snapshot.canUndo).toBe(false)
    expect(store.snapshot.canRedo).toBe(true)
  })

  it('весь drag — одна запись в истории', () => {
    const store = withNodes()
    store.begin('перетаскивание')
    for (let i = 0; i < 30; i++) {
      store.mutate('шаг', (d) => moveNodes(d, new Set(['a']), { x: 1, y: 0 }))
    }
    store.commit()
    expect(store.doc.nodes[0]?.x).toBe(30)
    store.undo()
    expect(store.doc.nodes[0]?.x).toBe(0)
    expect(store.snapshot.canUndo).toBe(false)
  })

  it('abort откатывает незакоммиченную транзакцию и не пишет историю', () => {
    const store = withNodes()
    store.begin('перетаскивание')
    store.mutate('шаг', (d) => moveNodes(d, new Set(['a']), { x: 99, y: 0 }))
    store.abort()
    expect(store.doc.nodes[0]?.x).toBe(0)
    expect(store.snapshot.canUndo).toBe(false)
  })

  it('повторный begin без commit — ошибка', () => {
    const store = withNodes()
    store.begin('первая')
    expect(() => store.begin('вторая')).toThrow()
  })

  it('mutateSilent не попадает в историю, но помечает файл грязным', () => {
    const store = withNodes()
    store.mutateSilent((d) => patchNodes(d, new Map([['a', { text: 'изменено' }]])))
    expect(store.snapshot.canUndo).toBe(false)
    expect(store.snapshot.dirty).toBe(true)
  })

  it('новая правка после undo стирает redo', () => {
    const store = withNodes()
    store.mutate('раз', (d) => moveNodes(d, new Set(['a']), { x: 10, y: 0 }))
    store.undo()
    expect(store.snapshot.canRedo).toBe(true)
    store.mutate('два', (d) => moveNodes(d, new Set(['b']), { x: 5, y: 0 }))
    expect(store.snapshot.canRedo).toBe(false)
  })

  it('undo выкидывает из выделения исчезнувшие ноды', () => {
    const store = withNodes()
    store.mutate('добавил', (d) => insertNodes(d, [makeNode({ type: 'text', text: 'новая' }, rect(500, 0))]))
    const added = store.doc.nodes[2]
    if (!added) throw new Error('нода не добавилась')
    store.selectNodes([added.id])
    expect(store.snapshot.selection.size).toBe(1)
    store.undo()
    expect(store.snapshot.selection.size).toBe(0)
  })

  it('выделение не меняет ссылку на множество, если состав тот же', () => {
    const store = withNodes()
    store.selectNodes(['a'])
    const first = store.snapshot.selection
    store.selectNodes(['a'])
    expect(store.snapshot.selection).toBe(first)
  })

  it('режимы выделения', () => {
    const store = withNodes()
    store.selectNodes(['a'])
    store.selectNodes(['b'], 'add')
    expect([...store.snapshot.selection].sort()).toEqual(['a', 'b'])
    store.selectNodes(['a'], 'toggle')
    expect([...store.snapshot.selection]).toEqual(['b'])
    store.selectAll()
    expect(store.snapshot.selection.size).toBe(2)
    store.clearSelection()
    expect(store.snapshot.selection.size).toBe(0)
  })

  it('история ограничена сверху', () => {
    const store = new DocStore()
    store.load(docWith(textNode('a', 0, 0)))
    for (let i = 0; i < 250; i++) {
      store.mutate('сдвиг', (d) => moveNodes(d, new Set(['a']), { x: 1, y: 0 }))
    }
    let undos = 0
    while (store.snapshot.canUndo && undos < 500) {
      store.undo()
      undos++
    }
    expect(undos).toBe(200)
  })

  it('пустой документ не ломает undo и redo', () => {
    const store = new DocStore()
    store.load(EMPTY_DOC)
    store.undo()
    store.redo()
    expect(store.doc.nodes).toHaveLength(0)
  })
})
