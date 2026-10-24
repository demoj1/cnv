import type { AgentEdge, AgentNode, AgentRect } from '@shared/agent'
import { matchName } from './name-match'

/**
 * Поиск нод для агентов: чтобы не тянуть весь холст на каждый вопрос «где карточки про X».
 * Условия складываются через И; пустой запрос — все ноды.
 */
export interface NodeQuery {
  /** Подстрока (без регистра) в тексте, имени, роли, подписи, url или пути файла; `/…/флаги` — регулярка. */
  text?: string
  kinds?: readonly string[]
  /** "1".."6", "#rrggbb" или "none" — без цвета. */
  color?: string
  desktop?: number
  /** Нода целиком внутри прямоугольника (мировые координаты). */
  within?: AgentRect
  /** Нода хотя бы задевает прямоугольник. */
  intersects?: AgentRect
  /** Нода целиком внутри группы с этим id или подписью. */
  group?: string
  /** Соединена связью с нодой (id или имя). */
  connectedTo?: string
  name?: string
  role?: string
}

const inside = (r: AgentRect, box: AgentRect): boolean =>
  r.x >= box.x && r.y >= box.y && r.x + r.width <= box.x + box.width && r.y + r.height <= box.y + box.height

const touches = (r: AgentRect, box: AgentRect): boolean =>
  r.x < box.x + box.width && box.x < r.x + r.width && r.y < box.y + box.height && box.y < r.y + r.height

function textMatcher(pattern: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/i.exec(pattern)
  if (re) {
    let rx: RegExp
    try {
      rx = new RegExp(re[1]!, re[2]!.includes('i') ? re[2] : `${re[2]}i`)
    } catch {
      throw new Error(`кривая регулярка ${pattern}`)
    }
    return (s) => rx.test(s)
  }
  const needle = pattern.toLowerCase()
  return (s) => s.toLowerCase().includes(needle)
}

const searchable = (n: AgentNode): string =>
  [n.text, n.name, n.role, n.label, n.url, n.file].filter(Boolean).join('\n')

export function queryNodes(
  nodes: readonly AgentNode[],
  edges: readonly AgentEdge[],
  q: NodeQuery
): AgentNode[] {
  let out = [...nodes]
  if (q.kinds?.length) out = out.filter((n) => q.kinds!.includes(n.kind))
  if (q.desktop !== undefined) out = out.filter((n) => n.desktop === q.desktop)
  if (q.color !== undefined) {
    const none = ['none', 'null', ''].includes(q.color.toLowerCase())
    out = out.filter((n) => (none ? !n.color : n.color?.toLowerCase() === q.color!.toLowerCase()))
  }
  if (q.within) out = out.filter((n) => inside(n, q.within!))
  if (q.intersects) out = out.filter((n) => touches(n, q.intersects!))
  if (q.group !== undefined) {
    const groups = nodes.filter((n) => n.kind === 'group')
    const group = groups.find((g) => g.id === q.group) ?? matchName(groups, q.group, (g) => g.label).hit
    if (!group) throw new Error(`нет группы «${q.group}»`)
    out = out.filter((n) => n.id !== group.id && inside(n, group))
  }
  if (q.connectedTo !== undefined) {
    const peer =
      nodes.find((n) => n.id === q.connectedTo) ?? matchName(nodes, q.connectedTo, (n) => n.name).hit
    if (!peer) throw new Error(`нет ноды «${q.connectedTo}»`)
    const linked = new Set(
      edges.flatMap((e) => (e.fromNode === peer.id ? [e.toNode] : e.toNode === peer.id ? [e.fromNode] : []))
    )
    out = out.filter((n) => linked.has(n.id))
  }
  if (q.name !== undefined) {
    const m = textMatcher(q.name)
    out = out.filter((n) => n.name !== undefined && m(n.name))
  }
  if (q.role !== undefined) {
    const m = textMatcher(q.role)
    out = out.filter((n) => n.role !== undefined && m(n.role))
  }
  if (q.text !== undefined) {
    const m = textMatcher(q.text)
    out = out.filter((n) => m(searchable(n)))
  }
  return out
}
