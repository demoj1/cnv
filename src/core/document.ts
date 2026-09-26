import type { CanvasEdge, CanvasNode, CanvasNodeType, UnknownFields } from '@shared/canvas'
import type { Rect } from './geometry'

/**
 * Внутреннее представление: типизированные известные поля плюс `extra` — всё, чего мы
 * не знаем. `extra` едет из файла в файл нетронутым (round-trip по ТЗ 4.1).
 */
export type DocNode = CanvasNode & { extra: UnknownFields }
export type DocEdge = CanvasEdge & { extra: UnknownFields }

export interface CanvasDoc {
  /** Порядок массива — это z-order. Группы рисуются ниже обычных нод. */
  nodes: readonly DocNode[]
  edges: readonly DocEdge[]
  extra: UnknownFields
}

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [], extra: {} }

export const nodeRect = (n: DocNode): Rect => ({ x: n.x, y: n.y, width: n.width, height: n.height })

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

export function nodeMap(doc: CanvasDoc): Map<string, DocNode> {
  return new Map(doc.nodes.map((n) => [n.id, n]))
}

export function findNode(doc: CanvasDoc, id: string): DocNode | undefined {
  return doc.nodes.find((n) => n.id === id)
}

export function findEdge(doc: CanvasDoc, id: string): DocEdge | undefined {
  return doc.edges.find((e) => e.id === id)
}

export const isGroup = (n: DocNode): boolean => n.type === 'group'

/** Группы всегда ниже обычных нод — требование ТЗ 7.4, а не свойство файла. */
export function renderOrder(nodes: readonly DocNode[]): readonly DocNode[] {
  const groups: DocNode[] = []
  const rest: DocNode[] = []
  for (const n of nodes) (isGroup(n) ? groups : rest).push(n)
  return groups.concat(rest)
}

export function replaceNodes(doc: CanvasDoc, replacements: ReadonlyMap<string, DocNode>): CanvasDoc {
  if (replacements.size === 0) return doc
  let changed = false
  const nodes = doc.nodes.map((n) => {
    const next = replacements.get(n.id)
    if (!next || next === n) return n
    changed = true
    return next
  })
  return changed ? { ...doc, nodes } : doc
}

export function addNodes(doc: CanvasDoc, nodes: readonly DocNode[]): CanvasDoc {
  return nodes.length === 0 ? doc : { ...doc, nodes: [...doc.nodes, ...nodes] }
}

export function removeEntities(
  doc: CanvasDoc,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>
): CanvasDoc {
  if (nodeIds.size === 0 && edgeIds.size === 0) return doc
  const nodes = doc.nodes.filter((n) => !nodeIds.has(n.id))
  const edges = doc.edges.filter(
    (e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)
  )
  return { ...doc, nodes, edges }
}

export function docBounds(doc: CanvasDoc): Rect | null {
  if (doc.nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of doc.nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x + n.width > maxX) maxX = n.x + n.width
    if (n.y + n.height > maxY) maxY = n.y + n.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export const NODE_TYPES: readonly CanvasNodeType[] = ['text', 'file', 'link', 'group']
