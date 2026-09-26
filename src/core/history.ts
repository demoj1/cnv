import type { CanvasDoc, DocEdge, DocNode } from './document'

export type EntityPatch<T> =
  | { kind: 'add'; after: T }
  | { kind: 'remove'; before: T }
  | { kind: 'update'; before: Partial<T>; after: Partial<T> }

export interface Transaction {
  label: string
  nodes: Map<string, EntityPatch<DocNode>>
  edges: Map<string, EntityPatch<DocEdge>>
  nodeOrder: { before: string[]; after: string[] } | null
  edgeOrder: { before: string[]; after: string[] } | null
  rootExtra: { before: Record<string, unknown>; after: Record<string, unknown> } | null
}

export class HistoryError extends Error {}

type Entity = DocNode | DocEdge

/**
 * Патчи — по полям, а не по объектам целиком. Это и есть механизм, из-за которого
 * навигация внутри веб-ноды (её `url` правится отдельно, мимо истории) не откатывается
 * вместе с чужим undo: откат вернёт только те ключи, которые трогала транзакция.
 */
function diffFields<T extends Entity>(before: T, after: T): { before: Partial<T>; after: Partial<T> } | null {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof T & string>
  const b: Partial<T> = {}
  const a: Partial<T> = {}
  let changed = false
  for (const key of keys) {
    const bv = before[key]
    const av = after[key]
    if (bv === av) continue
    if (JSON.stringify(bv) === JSON.stringify(av)) continue
    b[key] = bv
    a[key] = av
    changed = true
  }
  return changed ? { before: b, after: a } : null
}

function diffEntities<T extends Entity>(
  before: readonly T[],
  after: readonly T[]
): { patches: Map<string, EntityPatch<T>>; order: { before: string[]; after: string[] } | null } {
  const beforeMap = new Map(before.map((e) => [e.id, e]))
  const afterMap = new Map(after.map((e) => [e.id, e]))
  const patches = new Map<string, EntityPatch<T>>()

  for (const [id, b] of beforeMap) {
    const a = afterMap.get(id)
    if (!a) {
      patches.set(id, { kind: 'remove', before: b })
      continue
    }
    if (a === b) continue
    const fields = diffFields(b, a)
    if (fields) patches.set(id, { kind: 'update', ...fields })
  }
  for (const [id, a] of afterMap) {
    if (!beforeMap.has(id)) patches.set(id, { kind: 'add', after: a })
  }

  const beforeIds = before.map((e) => e.id)
  const afterIds = after.map((e) => e.id)
  const sameOrder = beforeIds.length === afterIds.length && beforeIds.every((id, i) => id === afterIds[i])

  return { patches, order: sameOrder ? null : { before: beforeIds, after: afterIds } }
}

export function diffDocs(before: CanvasDoc, after: CanvasDoc, label: string): Transaction | null {
  if (before === after) return null
  const nodes = diffEntities(before.nodes, after.nodes)
  const edges = diffEntities(before.edges, after.edges)
  const rootChanged = JSON.stringify(before.extra) !== JSON.stringify(after.extra)

  if (nodes.patches.size === 0 && edges.patches.size === 0 && !nodes.order && !edges.order && !rootChanged) {
    return null
  }

  return {
    label,
    nodes: nodes.patches,
    edges: edges.patches,
    nodeOrder: nodes.order,
    edgeOrder: edges.order,
    rootExtra: rootChanged ? { before: before.extra, after: after.extra } : null
  }
}

function applyEntities<T extends Entity>(
  current: readonly T[],
  patches: ReadonlyMap<string, EntityPatch<T>>,
  order: { before: string[]; after: string[] } | null,
  undo: boolean
): readonly T[] {
  if (patches.size === 0 && !order) return current

  const map = new Map(current.map((e) => [e.id, e]))
  for (const [id, patch] of patches) {
    switch (patch.kind) {
      case 'add':
        if (undo) map.delete(id)
        else map.set(id, patch.after)
        break
      case 'remove':
        if (undo) map.set(id, patch.before)
        else map.delete(id)
        break
      case 'update': {
        const existing = map.get(id)
        if (!existing) throw new HistoryError(`история рассинхронизирована: нет сущности ${id}`)
        map.set(id, { ...existing, ...(undo ? patch.before : patch.after) })
        break
      }
    }
  }

  const ids = order ? (undo ? order.before : order.after) : current.map((e) => e.id)
  const result: T[] = []
  for (const id of ids) {
    const e = map.get(id)
    if (!e) throw new HistoryError(`история рассинхронизирована: потерян порядок для ${id}`)
    result.push(e)
    map.delete(id)
  }
  // Сущности, появившиеся мимо транзакции, порядок не ломают — дописываем в хвост.
  for (const e of map.values()) result.push(e)
  return result
}

export function applyTransaction(doc: CanvasDoc, tx: Transaction, undo: boolean): CanvasDoc {
  return {
    nodes: applyEntities(doc.nodes, tx.nodes, tx.nodeOrder, undo),
    edges: applyEntities(doc.edges, tx.edges, tx.edgeOrder, undo),
    extra: tx.rootExtra ? (undo ? tx.rootExtra.before : tx.rootExtra.after) : doc.extra
  }
}

export function touchedNodeIds(tx: Transaction): string[] {
  return [...tx.nodes.keys()]
}
