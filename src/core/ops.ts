import type { CanvasColor, NodeSide } from '@shared/canvas'
import {
  addNodes,
  newId,
  nodeRect,
  removeEntities,
  replaceNodes,
  type CanvasDoc,
  type DocEdge,
  type DocNode
} from './document'
import { rectContains, type Point, type Rect, type Size } from './geometry'
import { terminalPlaceholder, withTerminalSpec } from './terminal'

type NodeInit =
  | { type: 'text'; text: string }
  | { type: 'file'; file: string; subpath?: string }
  | { type: 'link'; url: string }
  | { type: 'group'; label?: string }
  | { type: 'terminal'; shell: string; cwd?: string }

export function makeNode(init: NodeInit, rect: Rect, color?: CanvasColor): DocNode {
  const base = {
    id: newId(),
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    extra: {} as Record<string, unknown>,
    ...(color ? { color } : {})
  }
  switch (init.type) {
    case 'text':
      return { ...base, type: 'text', text: init.text }
    case 'file':
      return { ...base, type: 'file', file: init.file, ...(init.subpath ? { subpath: init.subpath } : {}) }
    case 'link':
      return { ...base, type: 'link', url: init.url }
    case 'group':
      return { ...base, type: 'group', ...(init.label ? { label: init.label } : {}) }
    case 'terminal':
      return {
        ...base,
        type: 'text',
        text: terminalPlaceholder(init.shell),
        extra: withTerminalSpec(base.extra, init.cwd ? { cwd: init.cwd } : {})
      }
  }
}

export function makeEdge(
  fromNode: string,
  toNode: string,
  sides?: { fromSide?: NodeSide; toSide?: NodeSide }
): DocEdge {
  return {
    id: newId(),
    fromNode,
    toNode,
    ...(sides?.fromSide ? { fromSide: sides.fromSide } : {}),
    ...(sides?.toSide ? { toSide: sides.toSide } : {}),
    extra: {}
  }
}

export const insertNodes = (doc: CanvasDoc, nodes: readonly DocNode[]): CanvasDoc => addNodes(doc, nodes)

export function insertEdges(doc: CanvasDoc, edges: readonly DocEdge[]): CanvasDoc {
  return edges.length === 0 ? doc : { ...doc, edges: [...doc.edges, ...edges] }
}

export function patchNodes(doc: CanvasDoc, patches: ReadonlyMap<string, Partial<DocNode>>): CanvasDoc {
  const replacements = new Map<string, DocNode>()
  for (const node of doc.nodes) {
    const patch = patches.get(node.id)
    if (patch) replacements.set(node.id, { ...node, ...patch } as DocNode)
  }
  return replaceNodes(doc, replacements)
}

export function patchEdge(doc: CanvasDoc, id: string, patch: Partial<DocEdge>): CanvasDoc {
  let changed = false
  const edges = doc.edges.map((e) => {
    if (e.id !== id) return e
    changed = true
    return { ...e, ...patch } as DocEdge
  })
  return changed ? { ...doc, edges } : doc
}

export function moveNodes(doc: CanvasDoc, ids: ReadonlySet<string>, delta: Point): CanvasDoc {
  if (ids.size === 0 || (delta.x === 0 && delta.y === 0)) return doc
  const patches = new Map<string, Partial<DocNode>>()
  for (const n of doc.nodes) {
    if (ids.has(n.id)) patches.set(n.id, { x: n.x + delta.x, y: n.y + delta.y })
  }
  return patchNodes(doc, patches)
}

export function setNodeRect(doc: CanvasDoc, id: string, rect: Rect): CanvasDoc {
  return patchNodes(doc, new Map([[id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]]))
}

export function deleteEntities(
  doc: CanvasDoc,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>
): CanvasDoc {
  return removeEntities(doc, nodeIds, edgeIds)
}

/** Копия выделения со смещением; рёбра между скопированными нодами переносятся (ТЗ 7.7). */
export function duplicateSubgraph(
  doc: CanvasDoc,
  nodeIds: ReadonlySet<string>,
  delta: Point
): { doc: CanvasDoc; newNodeIds: string[] } {
  if (nodeIds.size === 0) return { doc, newNodeIds: [] }
  const idMap = new Map<string, string>()
  const clones: DocNode[] = []
  for (const n of doc.nodes) {
    if (!nodeIds.has(n.id)) continue
    const id = newId()
    idMap.set(n.id, id)
    clones.push({ ...n, id, x: n.x + delta.x, y: n.y + delta.y, extra: { ...n.extra } })
  }
  const edgeClones: DocEdge[] = []
  for (const e of doc.edges) {
    const from = idMap.get(e.fromNode)
    const to = idMap.get(e.toNode)
    if (from && to) edgeClones.push({ ...e, id: newId(), fromNode: from, toNode: to, extra: { ...e.extra } })
  }
  return {
    doc: insertEdges(insertNodes(doc, clones), edgeClones),
    newNodeIds: clones.map((n) => n.id)
  }
}

export type ZOrderMove = 'front' | 'back' | 'forward' | 'backward'

export function reorderNodes(doc: CanvasDoc, ids: ReadonlySet<string>, move: ZOrderMove): CanvasDoc {
  if (ids.size === 0) return doc
  const nodes = [...doc.nodes]
  const selected = nodes.filter((n) => ids.has(n.id))
  const rest = nodes.filter((n) => !ids.has(n.id))
  if (selected.length === 0) return doc

  let next: DocNode[]
  switch (move) {
    case 'front':
      next = [...rest, ...selected]
      break
    case 'back':
      next = [...selected, ...rest]
      break
    case 'forward':
    case 'backward': {
      next = [...nodes]
      const step = move === 'forward' ? 1 : -1
      const order = move === 'forward' ? [...nodes.keys()].reverse() : [...nodes.keys()]
      for (const i of order) {
        const node = next[i]
        if (!node || !ids.has(node.id)) continue
        const j = i + step
        const neighbour = next[j]
        if (!neighbour || ids.has(neighbour.id)) continue
        next[i] = neighbour
        next[j] = node
      }
      break
    }
  }
  const same = next.length === nodes.length && next.every((n, i) => n === nodes[i])
  return same ? doc : { ...doc, nodes: next }
}

/** Ноды, целиком лежащие внутри группы, — те, что группа таскает за собой (ТЗ 6.4). */
export function nodesInsideGroup(doc: CanvasDoc, groupId: string): string[] {
  const group = doc.nodes.find((n) => n.id === groupId)
  if (!group || group.type !== 'group') return []
  const box = nodeRect(group)
  return doc.nodes.filter((n) => n.id !== groupId && rectContains(box, nodeRect(n))).map((n) => n.id)
}

export function groupSelection(
  doc: CanvasDoc,
  ids: ReadonlySet<string>,
  padding: number,
  label: string,
  minSize: Size
): { doc: CanvasDoc; groupId: string } | null {
  const rects = doc.nodes.filter((n) => ids.has(n.id)).map(nodeRect)
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  const group = makeNode(
    { type: 'group', label },
    {
      x: minX - padding,
      y: minY - padding,
      width: Math.max(maxX - minX + padding * 2, minSize.width),
      height: Math.max(maxY - minY + padding * 2, minSize.height)
    }
  )
  // Группа должна лежать под нодами — ставим в начало массива.
  return { doc: { ...doc, nodes: [group, ...doc.nodes] }, groupId: group.id }
}

export function ungroup(doc: CanvasDoc, ids: ReadonlySet<string>): CanvasDoc {
  const groupIds = new Set(doc.nodes.filter((n) => ids.has(n.id) && n.type === 'group').map((n) => n.id))
  return groupIds.size === 0 ? doc : removeEntities(doc, groupIds, new Set())
}
