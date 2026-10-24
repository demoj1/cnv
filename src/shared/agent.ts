import type { CanvasColor, EdgeEnd, NodeSide } from './canvas'

/**
 * Протокол между MCP-сервером в main и холстом в renderer. Документ живёт в renderer
 * (`DocStore`), поэтому всё, что агент делает с холстом, едет туда запросом и обратно
 * ответом — и попадает в ту же историю undo, что и правки руками.
 */

export type AgentNodeKind = 'text' | 'image' | 'pdf' | 'web' | 'group' | 'file' | 'terminal' | 'agent'

export interface AgentRect {
  x: number
  y: number
  width: number
  height: number
}

/** Нода так, как её видит агент: плоско, без внутренних полей хранения. */
export interface AgentNode extends AgentRect {
  id: string
  kind: AgentNodeKind
  /** Рабочий стол 1…10, на котором нода (Alt+1 … Alt+0 у человека). */
  desktop: number
  color?: CanvasColor
  text?: string
  /** Текст обрезан до лимита запроса; полный — через `get_node`. */
  truncated?: boolean
  file?: string
  url?: string
  label?: string
  /** Рабочая папка терминала. */
  cwd?: string
  /** Имя терминала или агента («Задумчивый Аркадий») — уникально на холсте. */
  name?: string
  /** Плагин агента: `claude`, `codex`, `opencode`… */
  agent?: string
  /** id сессии агента — появляется, когда агент её начал. */
  sessionId?: string
  /** Роль терминала, агента или страницы: кто есть кто. */
  role?: string
}

export interface AgentEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: NodeSide
  toSide?: NodeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: CanvasColor
  label?: string
}

export interface AgentCanvas {
  nodes: AgentNode[]
  edges: AgentEdge[]
  selection: string[]
  edgeSelection: string[]
  /** Нода, которую сейчас редактируют (фокус ввода). */
  activeNodeId: string | null
  /** Видимая область холста в мировых координатах. */
  viewport: AgentRect & { zoom: number }
  /** Стол, на который сейчас смотрит человек. */
  activeDesktop: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
}

export type AgentNodeInit =
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: string }
  | { kind: 'web'; url: string; name?: string; role?: string }
  | { kind: 'group'; label?: string }
  | { kind: 'terminal'; cwd?: string; name?: string; role?: string }
  | { kind: 'agent'; cwd?: string; name?: string; role?: string; prompt?: string; agent?: string }

export interface AgentPlacement {
  x?: number
  y?: number
  width?: number
  height?: number
  /** Без координат нода встаёт рядом с этой (обычно — с терминалом самого агента). */
  near?: string
  /** На какой стол; якорь с другого стола тогда не учитывается. */
  desktop?: number
}

export interface AgentNodePatch {
  x?: number
  y?: number
  width?: number
  height?: number
  /** `null` — снять цвет. */
  color?: CanvasColor | null
  text?: string
  url?: string
  label?: string
  /** Переименовать терминал, агента или страницу. */
  name?: string
  /** Новая роль; пустая строка — снять. */
  role?: string
}

export interface AgentEdgeInit {
  fromNode: string
  toNode: string
  fromSide?: NodeSide
  toSide?: NodeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: CanvasColor
  label?: string
}

export interface AgentEdgePatch {
  fromSide?: NodeSide
  toSide?: NodeSide
  fromEnd?: EdgeEnd
  toEnd?: EdgeEnd
  color?: CanvasColor | null
  label?: string | null
}

/** Методы моста: имя → параметры и результат. Одна таблица на обе стороны. */
export interface AgentMethods {
  getCanvas: { params: { maxText: number }; result: AgentCanvas }
  getNodes: { params: { ids: string[] }; result: AgentNode[] }
  /** Терминал или агент по id ноды или по имени. */
  findTerminal: { params: { ref: string }; result: AgentNode }
  /** Веб-страница по id или имени и её гость (`null` — страница сейчас не загружена). */
  findWeb: { params: { ref: string }; result: { node: AgentNode; webContentsId: number | null } }
  createNode: {
    params: { init: AgentNodeInit; place: AgentPlacement; color?: CanvasColor }
    result: AgentNode
  }
  updateNode: { params: { id: string; patch: AgentNodePatch }; result: AgentNode }
  createEdge: { params: AgentEdgeInit; result: AgentEdge }
  updateEdge: { params: { id: string; patch: AgentEdgePatch }; result: AgentEdge }
  delete: { params: { ids: string[] }; result: { nodes: string[]; edges: string[] } }
  select: { params: { ids: string[] }; result: { nodes: string[]; edges: string[] } }
  zoomTo: { params: { ids: string[] }; result: { viewport: AgentRect & { zoom: number } } }
  runCommand: { params: { id: string }; result: { ran: boolean } }
  save: { params: Record<string, never>; result: { saved: boolean } }
  switchDesktop: { params: { desktop: number }; result: { activeDesktop: number } }
  moveToDesktop: { params: { ids: string[]; desktop: number }; result: { moved: string[] } }
  /** Экран терминала так, как его видит человек: последние `lines` строк буфера xterm. */
  readTerminal: { params: { id: string; lines: number }; result: AgentTerminalScreen }
}

export interface AgentTerminalScreen {
  text: string
  cols: number
  rows: number
  /** Строк в буфере всего, вместе со scrollback. */
  total: number
}

export type AgentMethod = keyof AgentMethods

export interface AgentRequest<M extends AgentMethod = AgentMethod> {
  id: number
  method: M
  params: AgentMethods[M]['params']
}

export type AgentResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
