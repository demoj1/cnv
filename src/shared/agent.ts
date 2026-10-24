import type { CanvasColor, EdgeEnd, NodeSide } from './canvas'
import type { PortalDelivery, PortalMemberView, PortalView, PortalWireMessage } from './portal'

/**
 * Протокол между MCP-сервером в main и холстом в renderer. Документ живёт в renderer
 * (`DocStore`), поэтому всё, что агент делает с холстом, едет туда запросом и обратно
 * ответом — и попадает в ту же историю undo, что и правки руками.
 */

export type AgentNodeKind =
  'text' | 'image' | 'pdf' | 'web' | 'group' | 'file' | 'terminal' | 'agent' | 'portal'

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
  /** Файл — копия снаружи workspace, которая следует за этим оригиналом. */
  source?: string
  url?: string
  label?: string
  /** Рабочая папка терминала. */
  cwd?: string
  /** Имя терминала или агента («Задумчивый Даня») — уникально на холсте. */
  name?: string
  /** Плагин агента: `claude`, `codex`, `opencode`… */
  agent?: string
  /** id сессии агента — появляется, когда агент её начал. */
  sessionId?: string
  /** Роль терминала, агента или страницы: кто есть кто. */
  role?: string
  /** Модель агента, если задана. */
  model?: string
  /** Значок агента. */
  icon?: string
  /** Агент свёрнут в кружок. */
  collapsed?: boolean
  /** Что агент сказал о своей работе: прогресс 0…100 и строка. */
  status?: { progress?: number; text?: string; at: string }
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
  | { kind: 'file'; file: string; source?: string }
  | { kind: 'web'; url: string; name?: string; role?: string }
  | { kind: 'group'; label?: string }
  | { kind: 'portal'; key?: string; label?: string }
  | { kind: 'terminal'; cwd?: string; name?: string; role?: string }
  | {
      kind: 'agent'
      cwd?: string
      name?: string
      role?: string
      prompt?: string
      agent?: string
      /** Модель агента; нет — какая в команде запуска. */
      model?: string
    }

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
  /** Агенту — продолжать эту сессию; пустая строка — начать новую. */
  sessionId?: string
  /** Модель агента; пустая строка — какая в команде запуска. Агент перезапускается в той же сессии. */
  model?: string
  /** Значок агента — emoji; пустая строка — снять. */
  icon?: string
  /** Свернуть агента в кружок или развернуть обратно. */
  collapsed?: boolean
  /** Статус агента; `null` — снять. Правится мимо истории undo. */
  status?: { progress?: number; text?: string } | null
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

/**
 * Операция пакета `batch`: всё применяется одной правкой — или ничего. Созданное можно
 * назвать `ref` и сослаться на него дальше в этом же пакете как `$ref` (id, near, from, to).
 */
export type AgentBatchOp =
  | { op: 'create_node'; ref?: string; init: AgentNodeInit; place: AgentPlacement; color?: CanvasColor }
  | { op: 'update_node'; id: string; patch: AgentNodePatch }
  | { op: 'create_edge'; ref?: string; edge: AgentEdgeInit }
  | { op: 'update_edge'; id: string; patch: AgentEdgePatch }
  | { op: 'delete'; ids: string[] }

/** Запись журнала правок: кто, что, когда. */
export interface AgentJournalEntry {
  seq: number
  at: number
  label: string
  /** «человек», «Бесстрашная Прасковья (id)», «внешний клиент MCP». */
  actor: string
  kind: 'edit' | 'undo' | 'redo'
  nodes: { added: string[]; removed: string[]; changed: string[] }
  edges: { added: string[]; removed: string[]; changed: string[] }
}

export interface AgentBatchResult {
  /** Итог каждой операции по порядку. */
  results: (AgentNode | AgentEdge | { nodes: string[]; edges: string[] })[]
  /** `ref` → настоящий id созданного. */
  refs: Record<string, string>
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
  /** `restart` — перезапустить процесс терминала (агент сразу продолжит новую сессию). */
  updateNode: { params: { id: string; patch: AgentNodePatch; restart?: boolean }; result: AgentNode }
  createEdge: { params: AgentEdgeInit; result: AgentEdge }
  updateEdge: { params: { id: string; patch: AgentEdgePatch }; result: AgentEdge }
  delete: { params: { ids: string[] }; result: { nodes: string[]; edges: string[] } }
  select: { params: { ids: string[] }; result: { nodes: string[]; edges: string[] } }
  /**
   * Камера человека. `force` — человек сам попросил показать; без него, пока человек водит
   * мышью, камера не двигается и в ответе `skipped` — почему.
   */
  zoomTo: {
    params: { ids: string[]; force?: boolean }
    result: { viewport: AgentRect & { zoom: number }; skipped?: string }
  }
  runCommand: { params: { id: string; force?: boolean }; result: { ran: boolean; skipped?: string } }
  save: { params: Record<string, never>; result: { saved: boolean } }
  batch: { params: { ops: AgentBatchOp[] }; result: AgentBatchResult }
  history: { params: { since?: number; limit?: number }; result: AgentJournalEntry[] }
  /** Порталы на холсте: состояние, кто на той стороне и кто там подключён. */
  portalInfo: { params: { ids?: string[] }; result: PortalView[] }
  /**
   * Куда слать письмо агенту на той стороне: портал, соединённый стрелкой с отправителем,
   * и адресат среди подключённых к нему там. `ref` — «портал/id» или имя. null — не нашёлся.
   */
  portalRoute: {
    params: { from: string; ref: string }
    result: { portalId: string; label: string; peerName: string; member: PortalMemberView } | null
  }
  portalSend: { params: { portalId: string; message: PortalWireMessage }; result: PortalDelivery }
  /** Ключ портала — только тому, кто его создал (в ответе create_node). */
  portalKey: { params: { id: string }; result: { key: string } }
  /** Агент сходил по адресу (web_fetch): огонёк к открытым на холсте страницам того же сайта. */
  noteFetch: { params: { url: string }; result: { pulsed: string[] } }
  /** Что нужно для снимка нод: сами ноды, связи между ними, экраны терминалов, id гостей веб-страниц. */
  snapshotSource: {
    params: { ids?: string[]; rect?: AgentRect; padding?: number }
    result: {
      nodes: unknown[]
      edges: unknown[]
      rect: AgentRect
      terminals: Record<string, string>
      webGuests: Record<string, number>
    }
  }
  /** Вернуть удалённые ноды по id — с их связями, если оба конца на месте. */
  restore: {
    params: { ids: string[] }
    result: { restored: string[]; edges: string[]; missing: string[]; alreadyThere: string[] }
  }
  switchDesktop: {
    params: { desktop: number; force?: boolean }
    result: { activeDesktop: number; skipped?: string }
  }
  moveToDesktop: { params: { ids: string[]; desktop: number }; result: { moved: string[] } }
  /** Экран терминала так, как его видит человек: последние `lines` строк буфера xterm. */
  /** `typedOnly` — тусклые подсказки пробелами: виден только набранный текст. */
  readTerminal: { params: { id: string; lines: number; typedOnly?: boolean }; result: AgentTerminalScreen }
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
  /** Кто из агентов спрашивает: nodeId его терминала, null — внешний клиент. */
  caller?: { nodeId: string | null }
}

export type AgentResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
