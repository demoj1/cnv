import { newId, type CanvasDoc, type DocEdge, type DocNode } from './document'
import { unionRects } from './geometry'
import type { Point } from './geometry'
import { nodeRect } from './document'
import { insertEdges, insertNodes } from './ops'

/** Кусок холста: те же поля, что у документа, поэтому его можно вставить и в Obsidian. */
export function fragmentFromSelection(doc: CanvasDoc, nodeIds: ReadonlySet<string>): CanvasDoc {
  const nodes = doc.nodes.filter((n) => nodeIds.has(n.id))
  const edges = doc.edges.filter((e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode))
  return { nodes, edges, extra: {} }
}

export interface PasteResult {
  doc: CanvasDoc
  newNodeIds: string[]
}

/**
 * Вставка фрагмента: идентификаторы перевыдаются, рёбра внутри фрагмента переносятся,
 * `at` — куда лечь левому верхнему углу фрагмента.
 */
export function pasteFragment(doc: CanvasDoc, fragment: CanvasDoc, at: Point): PasteResult {
  if (fragment.nodes.length === 0) return { doc, newNodeIds: [] }
  const bounds = unionRects(fragment.nodes.map(nodeRect))
  if (!bounds) return { doc, newNodeIds: [] }
  const dx = at.x - bounds.x
  const dy = at.y - bounds.y

  const idMap = new Map<string, string>()
  const nodes: DocNode[] = fragment.nodes.map((n) => {
    const id = newId()
    idMap.set(n.id, id)
    return { ...n, id, x: n.x + dx, y: n.y + dy, extra: { ...n.extra } }
  })

  const edges: DocEdge[] = []
  for (const e of fragment.edges) {
    const from = idMap.get(e.fromNode)
    const to = idMap.get(e.toNode)
    if (from && to) edges.push({ ...e, id: newId(), fromNode: from, toNode: to, extra: { ...e.extra } })
  }

  return { doc: insertEdges(insertNodes(doc, nodes), edges), newNodeIds: nodes.map((n) => n.id) }
}

const URL_ONLY = /^(https?:\/\/|www\.)\S+$/i

export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim()
  if (!URL_ONLY.test(trimmed)) return false
  try {
    new URL(trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed)
    return true
  } catch {
    return false
  }
}

export const normalizeUrl = (text: string): string => {
  const trimmed = text.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}
