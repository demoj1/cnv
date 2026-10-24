import type { CanvasDoc, DocEdge, DocNode } from './document'
import { isAgent } from './terminal'
import { nodeKind } from './node-kind'
import { nodeName, nodeRole } from './node-name'
import { portalSpec } from './portal'

/**
 * Агенту — что поменялось вокруг него: связи появились и пропали, у связей и соседей
 * сменился цвет или подпись, сменился цвет его карточки. Иначе он узнаёт о новой команде,
 * только если сам спросит `connections`.
 */

export interface EdgeNotice {
  nodeId: string
  text: string
}

const COLORS: Record<string, string> = {
  '1': 'красный',
  '2': 'оранжевый',
  '3': 'жёлтый',
  '4': 'зелёный',
  '5': 'голубой',
  '6': 'фиолетовый'
}

const colorName = (color: string | undefined): string => (color ? (COLORS[color] ?? color) : 'без цвета')

/** Начало карточки без разметки: «## **План**» → «План». */
function plainStart(text: string): string {
  return text
    .replace(/[#*_`>~|]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()
}

function describe(node: DocNode | undefined): string {
  if (!node) return 'удалённая нода'
  const name = nodeName(node)
  const role = nodeRole(node)
  const kind = nodeKind(node)
  let who: string
  if (name) who = `${isAgent(node) ? 'агент' : kind === 'web' ? 'страница' : 'терминал'} «${name}»`
  else if (kind === 'portal') who = `портал «${portalSpec(node)?.label ?? node.id}»`
  else if (node.type === 'text') who = `карточка «${plainStart(node.text)}»`
  else if (node.type === 'group') who = `группа «${node.label ?? node.id}»`
  else if (node.type === 'file') who = `файл ${node.file}`
  else who = `нода ${node.id}`
  return `${who} (id ${node.id}${role ? `, роль: ${role}` : ''})`
}

/** Связь глазами агента `me`: в какую сторону стрелка и с кем. */
function link(edge: DocEdge, me: string, nodes: Map<string, DocNode>, details = true): string {
  const out = edge.fromNode === me
  const peer = describe(nodes.get(out ? edge.toNode : edge.fromNode))
  const label = details && edge.label ? `, подпись «${edge.label}»` : ''
  const color = details && edge.color ? `, цвет ${colorName(edge.color)}` : ''
  return `${out ? 'стрелка от тебя к' : 'стрелка к тебе от'}: ${peer}${label}${color}`
}

const touches = (edge: DocEdge, id: string): boolean => edge.fromNode === id || edge.toNode === id

/**
 * Что сказать каждому агенту, если холст стал из `before` таким, как `after`.
 * `skip` — агенты, которые всё это сделали сами: им писать незачем.
 */
export function edgeNotices(
  before: CanvasDoc,
  after: CanvasDoc,
  skip: ReadonlySet<string> = new Set()
): EdgeNotice[] {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]))
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]))
  // Подписи пропавших связей и нод берём из «было», остальные — из «стало».
  const allNodes = new Map([...beforeNodes, ...afterNodes])
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]))
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]))

  const notices: EdgeNotice[] = []
  for (const me of after.nodes) {
    if (!isAgent(me) || skip.has(me.id) || !beforeNodes.has(me.id)) continue
    const lines: string[] = []
    const was = beforeNodes.get(me.id) as DocNode
    if (was.color !== me.color)
      lines.push(`~ твоя карточка: цвет ${colorName(was.color)} → ${colorName(me.color)}`)

    const neighbours = new Set<string>()
    for (const edge of after.edges) {
      if (!touches(edge, me.id)) continue
      const peer = edge.fromNode === me.id ? edge.toNode : edge.fromNode
      const old = beforeEdges.get(edge.id)
      if (!old) {
        lines.push(`+ ${link(edge, me.id, allNodes)}`)
        continue
      }
      neighbours.add(peer)
      const changes: string[] = []
      if (old.color !== edge.color) changes.push(`цвет ${colorName(old.color)} → ${colorName(edge.color)}`)
      if ((old.label ?? '') !== (edge.label ?? ''))
        changes.push(`подпись «${old.label ?? ''}» → «${edge.label ?? ''}»`)
      if (changes.length) lines.push(`~ ${link(edge, me.id, allNodes, false)}: ${changes.join(', ')}`)
    }
    for (const edge of before.edges) {
      if (touches(edge, me.id) && !afterEdges.has(edge.id)) lines.push(`− ${link(edge, me.id, allNodes)}`)
    }
    // Цвет соседа — часто его статус: «готово», «сломано».
    for (const id of neighbours) {
      const a = beforeNodes.get(id)
      const b = afterNodes.get(id)
      if (a && b && a.color !== b.color)
        lines.push(`~ сосед ${describe(b)}: цвет ${colorName(a.color)} → ${colorName(b.color)}`)
    }
    if (lines.length) notices.push({ nodeId: me.id, text: lines.join('\n') })
  }
  return notices
}
