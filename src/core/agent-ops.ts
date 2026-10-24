import type {
  AgentEdge,
  AgentEdgeInit,
  AgentEdgePatch,
  AgentNode,
  AgentNodeInit,
  AgentNodePatch,
  AgentPlacement
} from '@shared/agent'
import type { CanvasColor } from '@shared/canvas'
import { findEdge, findNode, nodeRect, type CanvasDoc, type DocEdge, type DocNode } from './document'
import { rectsIntersect, type Rect, type Size } from './geometry'
import { desktopOfNode } from './desktops'
import { nodeKind } from './node-kind'
import { uniqueName } from './names'
import { makeEdge, makeNode, patchEdge, patchNodes } from './ops'
import { isNameable, nodeName, nodeRole, withNodeName, withNodeRole } from './node-name'
import { isTerminal, terminalSpec, withAgentSession } from './terminal'

/**
 * Чистые преобразования для агентов из MCP: как показать документ наружу и как
 * применить к нему то, что агент попросил. Без DOM и без IPC — тестируются юнитами.
 */

export class AgentOpError extends Error {}

/** Зазор между нодой-якорем и новой нодой рядом с ней. */
const GAP = 40

export function toAgentNode(node: DocNode, maxText = Infinity): AgentNode {
  const out: AgentNode = {
    id: node.id,
    kind: nodeKind(node),
    desktop: desktopOfNode(node),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.color ? { color: node.color } : {})
  }
  switch (node.type) {
    case 'text': {
      const spec = terminalSpec(node)
      if (spec) {
        if (spec.agent) {
          out.kind = 'agent'
          out.agent = spec.agent.plugin ?? 'claude'
          if (spec.agent.sessionId) out.sessionId = spec.agent.sessionId
        }
        if (spec.name) out.name = spec.name
        if (spec.role) out.role = spec.role
        if (spec.cwd) out.cwd = spec.cwd
        break
      }
      if (node.text.length > maxText) {
        out.text = node.text.slice(0, maxText)
        out.truncated = true
      } else {
        out.text = node.text
      }
      break
    }
    case 'file':
      out.file = node.file
      break
    case 'link': {
      out.url = node.url
      const name = nodeName(node)
      if (name) out.name = name
      const role = nodeRole(node)
      if (role) out.role = role
      break
    }
    case 'group':
      if (node.label) out.label = node.label
      break
  }
  return out
}

export function toAgentEdge(edge: DocEdge): AgentEdge {
  const out: AgentEdge = { id: edge.id, fromNode: edge.fromNode, toNode: edge.toNode }
  if (edge.fromSide) out.fromSide = edge.fromSide
  if (edge.toSide) out.toSide = edge.toSide
  if (edge.fromEnd) out.fromEnd = edge.fromEnd
  if (edge.toEnd) out.toEnd = edge.toEnd
  if (edge.color) out.color = edge.color
  if (edge.label) out.label = edge.label
  return out
}

export interface DefaultSizes {
  text: Size
  web: Size
}

export function defaultSize(init: AgentNodeInit, sizes: DefaultSizes): Size {
  switch (init.kind) {
    case 'text':
      return sizes.text
    case 'web':
      return sizes.web
    case 'file':
      return { width: 400, height: 300 }
    case 'group':
      return { width: 600, height: 400 }
    case 'terminal':
    case 'agent':
      return { width: 720, height: 420 }
  }
}

/** Имена всех именованных нод (терминалы, агенты, веб-страницы) на холсте. */
export function nodeNames(doc: CanvasDoc, except?: string): Set<string> {
  const out = new Set<string>()
  for (const n of doc.nodes) {
    const name = n.id === except ? undefined : nodeName(n)
    if (name) out.add(name)
  }
  return out
}

function checkName(doc: CanvasDoc, name: string, except?: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new AgentOpError('имя не может быть пустым')
  if (nodeNames(doc, except).has(trimmed)) throw new AgentOpError(`имя «${trimmed}» уже занято`)
  return trimmed
}

export interface BuildOptions {
  /** Подпись шелла для Obsidian; сам процесс берёт шелл из настроек. */
  shell: string
  color?: CanvasColor
  /** Плагин агента, если в init он не указан. */
  defaultAgent: string
}

/**
 * Куда поставить ноду без явных координат: справа от якоря, а если там занято — ниже,
 * пока не найдётся свободное место. Без якоря — в центр того, что видно на экране, а
 * если просили другой стол — в центр его вида (`viewOf`).
 */
export function placeRect(
  doc: CanvasDoc,
  place: AgentPlacement,
  size: Size,
  viewport: Rect,
  viewOf: (desktop: number) => Rect = () => viewport
): Rect {
  const width = place.width ?? size.width
  const height = place.height ?? size.height
  if (place.x !== undefined && place.y !== undefined) return { x: place.x, y: place.y, width, height }

  let anchor = place.near ? findNode(doc, place.near) : undefined
  if (place.near && !anchor) throw new AgentOpError(`нет ноды ${place.near}`)
  if (anchor && place.desktop !== undefined && desktopOfNode(anchor) !== place.desktop) anchor = undefined
  if (!anchor) {
    const view = place.desktop !== undefined ? viewOf(place.desktop) : viewport
    return {
      x: place.x ?? Math.round(view.x + view.width / 2 - width / 2),
      y: place.y ?? Math.round(view.y + view.height / 2 - height / 2),
      width,
      height
    }
  }

  const others = doc.nodes.filter((n) => n.type !== 'group').map(nodeRect)
  const candidate: Rect = { x: anchor.x + anchor.width + GAP, y: anchor.y, width, height }
  for (let i = 0; i < 100; i++) {
    const hit = others.find((r) => rectsIntersect(r, candidate))
    if (!hit) break
    candidate.y = hit.y + hit.height + GAP
  }
  return candidate
}

export function buildNode(doc: CanvasDoc, init: AgentNodeInit, rect: Rect, options: BuildOptions): DocNode {
  const { shell, color } = options
  switch (init.kind) {
    case 'text':
      return makeNode({ type: 'text', text: init.text }, rect, color)
    case 'file':
      return makeNode({ type: 'file', file: init.file }, rect, color)
    case 'web': {
      if (!/^https?:\/\//i.test(init.url)) throw new AgentOpError(`нужен http(s) адрес: ${init.url}`)
      const name = init.name ? checkName(doc, init.name) : uniqueName(nodeNames(doc))
      const web = withNodeName(makeNode({ type: 'link', url: init.url }, rect, color), name)
      return init.role ? withNodeRole(web, init.role.trim()) : web
    }
    case 'group':
      return makeNode({ type: 'group', ...(init.label ? { label: init.label } : {}) }, rect, color)
    case 'terminal':
    case 'agent': {
      const name = init.name ? checkName(doc, init.name) : uniqueName(nodeNames(doc))
      const agent =
        init.kind === 'agent'
          ? {
              plugin: init.agent || options.defaultAgent,
              sessionId: '',
              ...(init.prompt ? { prompt: init.prompt } : {})
            }
          : undefined
      const node = makeNode(
        {
          type: 'terminal',
          shell,
          name,
          ...(init.cwd ? { cwd: init.cwd } : {}),
          ...(agent ? { agent } : {})
        },
        rect,
        color
      )
      return init.role ? withNodeRole(node, init.role.trim()) : node
    }
  }
}

/** Применить правку агента к ноде. Поле, которого у этого вида ноды нет, — ошибка, а не тишина. */
export function applyNodePatch(doc: CanvasDoc, id: string, patch: AgentNodePatch): CanvasDoc {
  const node = findNode(doc, id)
  if (!node) throw new AgentOpError(`нет ноды ${id}`)
  const next: Partial<DocNode> & { text?: string; url?: string; label?: string } = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (!Number.isFinite(value)) throw new AgentOpError(`${key} должно быть числом`)
    if ((key === 'width' || key === 'height') && value <= 0) throw new AgentOpError(`${key} должно быть > 0`)
    next[key] = value
  }
  if (patch.color !== undefined) next.color = patch.color ?? undefined
  if (patch.name !== undefined) {
    if (!isNameable(node)) throw new AgentOpError(`у ноды ${id} не бывает имени`)
    next.extra = withNodeName(node, checkName(doc, patch.name, id)).extra
  }
  if (patch.role !== undefined) {
    if (!isNameable(node)) throw new AgentOpError(`у ноды ${id} не бывает роли`)
    const base = next.extra ? { ...node, extra: next.extra } : node
    next.extra = withNodeRole(base, patch.role.trim()).extra
  }
  if (patch.text !== undefined) {
    if (node.type !== 'text' || isTerminal(node)) throw new AgentOpError(`у ноды ${id} нет текста`)
    next.text = patch.text
  }
  if (patch.url !== undefined) {
    if (node.type !== 'link') throw new AgentOpError(`нода ${id} не веб-страница`)
    if (!/^https?:\/\//i.test(patch.url)) throw new AgentOpError(`нужен http(s) адрес: ${patch.url}`)
    next.url = patch.url
  }
  if (patch.label !== undefined) {
    if (node.type !== 'group') throw new AgentOpError(`нода ${id} не группа`)
    next.label = patch.label
  }
  if (patch.sessionId !== undefined) {
    const agent = terminalSpec(node)?.agent
    if (!agent) throw new AgentOpError(`нода ${id} не агент — сессии у неё нет`)
    if (patch.sessionId && !/^[\w.:-]{4,128}$/.test(patch.sessionId)) {
      throw new AgentOpError(`кривой id сессии: ${patch.sessionId}`)
    }
    next.extra = withAgentSession(next.extra ?? node.extra, agent, patch.sessionId)
  }
  return patchNodes(doc, new Map([[id, next]]))
}

export function buildEdge(doc: CanvasDoc, init: AgentEdgeInit): DocEdge {
  for (const end of [init.fromNode, init.toNode]) {
    if (!findNode(doc, end)) throw new AgentOpError(`нет ноды ${end}`)
  }
  const edge = makeEdge(init.fromNode, init.toNode, {
    ...(init.fromSide ? { fromSide: init.fromSide } : {}),
    ...(init.toSide ? { toSide: init.toSide } : {})
  })
  return {
    ...edge,
    ...(init.fromEnd ? { fromEnd: init.fromEnd } : {}),
    ...(init.toEnd ? { toEnd: init.toEnd } : {}),
    ...(init.color ? { color: init.color } : {}),
    ...(init.label ? { label: init.label } : {})
  }
}

export function applyEdgePatch(doc: CanvasDoc, id: string, patch: AgentEdgePatch): CanvasDoc {
  if (!findEdge(doc, id)) throw new AgentOpError(`нет связи ${id}`)
  const next: Partial<DocEdge> = {}
  if (patch.fromSide !== undefined) next.fromSide = patch.fromSide
  if (patch.toSide !== undefined) next.toSide = patch.toSide
  if (patch.fromEnd !== undefined) next.fromEnd = patch.fromEnd
  if (patch.toEnd !== undefined) next.toEnd = patch.toEnd
  if (patch.color !== undefined) next.color = patch.color ?? undefined
  if (patch.label !== undefined) next.label = patch.label ?? undefined
  return patchEdge(doc, id, next)
}

/** Разложить смешанный список id на ноды и связи; неизвестный id — ошибка. */
export function splitIds(doc: CanvasDoc, ids: readonly string[]): { nodes: string[]; edges: string[] } {
  const nodes: string[] = []
  const edges: string[] = []
  for (const id of ids) {
    if (findNode(doc, id)) nodes.push(id)
    else if (findEdge(doc, id)) edges.push(id)
    else throw new AgentOpError(`нет ноды или связи ${id}`)
  }
  return { nodes, edges }
}
