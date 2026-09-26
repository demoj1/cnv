import { APP_DATA_KEY } from '@shared/app'
import type { Camera } from './camera'
import type { CanvasDoc } from './document'

/**
 * Состояние вида живёт в самом `.canvas`, в поле `x-cnv`: у приложения ровно один файл.
 * Obsidian посторонние поля переживает — проверено на живом редакторе (ADR-017).
 */
export interface CanvasViewState {
  camera?: Camera
  nodes?: Record<string, NodeViewState>
}

export interface NodeViewState {
  pdfPage?: number
  webZoom?: number
}

export const EMPTY_VIEW_STATE: CanvasViewState = {}

export function readViewState(doc: CanvasDoc): CanvasViewState {
  const raw = doc.extra[APP_DATA_KEY]
  return raw && typeof raw === 'object' ? (raw as CanvasViewState) : EMPTY_VIEW_STATE
}

export function writeViewState(doc: CanvasDoc, state: CanvasViewState): CanvasDoc {
  const current = doc.extra[APP_DATA_KEY]
  if (JSON.stringify(current) === JSON.stringify(state)) return doc
  return { ...doc, extra: { ...doc.extra, [APP_DATA_KEY]: state } }
}

export function nodeViewState(state: CanvasViewState, id: string): NodeViewState {
  return state.nodes?.[id] ?? {}
}

export function withNodeViewState(state: CanvasViewState, id: string, patch: NodeViewState): CanvasViewState {
  return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes?.[id], ...patch } } }
}

/** Выбрасывает из состояния вида ноды, которых в документе больше нет. */
export function pruneViewState(state: CanvasViewState, doc: CanvasDoc): CanvasViewState {
  if (!state.nodes) return state
  const alive = new Set(doc.nodes.map((n) => n.id))
  const nodes: Record<string, NodeViewState> = {}
  for (const [id, value] of Object.entries(state.nodes)) if (alive.has(id)) nodes[id] = value
  return Object.keys(nodes).length === Object.keys(state.nodes).length ? state : { ...state, nodes }
}
