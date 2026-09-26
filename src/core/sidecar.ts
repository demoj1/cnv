import type { Camera } from './camera'

/**
 * Состояние вида хранится рядом с канвасом, а не в нём: камера меняется на каждый pan,
 * и держать её в `.canvas` значило бы дёргать автосохранение и watcher без конца
 * (Obsidian посторонние поля переживает — проверено, дело не в совместимости).
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

export function sidecarPath(canvasRelPath: string): string {
  const slash = canvasRelPath.lastIndexOf('/')
  const dir = slash < 0 ? '' : canvasRelPath.slice(0, slash + 1)
  const name = slash < 0 ? canvasRelPath : canvasRelPath.slice(slash + 1)
  return `${dir}.${name}.state.json`
}

export function parseViewState(text: string | null): CanvasViewState {
  if (!text) return EMPTY_VIEW_STATE
  try {
    const raw: unknown = JSON.parse(text)
    return raw && typeof raw === 'object' ? (raw as CanvasViewState) : EMPTY_VIEW_STATE
  } catch {
    return EMPTY_VIEW_STATE
  }
}

export function nodeViewState(state: CanvasViewState, id: string): NodeViewState {
  return state.nodes?.[id] ?? {}
}

export function withNodeViewState(state: CanvasViewState, id: string, patch: NodeViewState): CanvasViewState {
  return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes?.[id], ...patch } } }
}
