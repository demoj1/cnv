import type { CanvasColor } from '@shared/canvas'
import type { CanvasDoc, DocNode } from './document'
import { newId } from './document'
import { isAgent } from './terminal'

/**
 * Канбан-доска — нода с дорожками, в дорожках markdown-карточки. Карточка на доске —
 * не нода холста, а часть доски: утащил на холст — стала обычной карточкой, бросил
 * карточку с холста на дорожку — встроилась. Хранится в текстовой ноде с пометкой
 * `x-cnv.board`, а текст ноды — та же доска markdown-списком: Obsidian её прочтёт.
 */

export interface BoardCard {
  id: string
  text: string
  color?: CanvasColor
}

export interface BoardLane {
  id: string
  title: string
  cards: BoardCard[]
}

export interface BoardSpec {
  title: string
  lanes: BoardLane[]
}

export class BoardError extends Error {}

export const BOARD_SIZE = { width: 960, height: 600 } as const
export const DEFAULT_LANES = ['Backlog', 'In progress', 'Done'] as const

const KEY = 'x-cnv'
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

export function boardSpec(node: DocNode): BoardSpec | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  const b = isRecord(own) ? own.board : undefined
  if (!isRecord(b) || !Array.isArray(b.lanes)) return null
  const lanes = b.lanes.filter(isRecord).map((l): BoardLane => ({
    id: typeof l.id === 'string' ? l.id : newId(),
    title: typeof l.title === 'string' ? l.title : '',
    cards: (Array.isArray(l.cards) ? l.cards : []).filter(isRecord).map((c): BoardCard => ({
      id: typeof c.id === 'string' ? c.id : newId(),
      text: typeof c.text === 'string' ? c.text : '',
      ...(typeof c.color === 'string' && c.color ? { color: c.color } : {})
    }))
  }))
  return { title: typeof b.title === 'string' ? b.title : 'Доска', lanes }
}

export const isBoard = (node: DocNode): boolean => boardSpec(node) !== null

/** Нода с новой доской: и пометка, и markdown для Obsidian. */
export function withBoard(node: DocNode, spec: BoardSpec): DocNode {
  if (node.type !== 'text') return node
  const own = isRecord(node.extra[KEY]) ? (node.extra[KEY] as Record<string, unknown>) : {}
  return { ...node, text: boardMarkdown(spec), extra: { ...node.extra, [KEY]: { ...own, board: spec } } }
}

export function newBoard(title = 'Доска', lanes: readonly string[] = DEFAULT_LANES): BoardSpec {
  return { title, lanes: lanes.map((t) => ({ id: newId(), title: t, cards: [] })) }
}

/** Первая строка карточки без разметки — её имя в письмах и подсказках. */
export function cardTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return (
    line
      .replace(/[#*_`>~|]+/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'без текста'
  )
}

export function boardMarkdown(spec: BoardSpec): string {
  const out = [`## ${spec.title}`]
  for (const lane of spec.lanes) {
    out.push('', `### ${lane.title}`)
    for (const card of lane.cards) out.push(`- ${cardTitle(card.text)}`)
  }
  return out.join('\n')
}

/** Дорожка по id или по названию (без регистра) — агентам удобнее писать «Done». */
export function findLane(spec: BoardSpec, ref: string): BoardLane {
  const lane =
    spec.lanes.find((l) => l.id === ref) ??
    spec.lanes.find((l) => l.title.trim().toLowerCase() === ref.trim().toLowerCase())
  if (!lane) throw new BoardError(`нет дорожки «${ref}»; есть: ${spec.lanes.map((l) => l.title).join(', ')}`)
  return lane
}

export function findCard(
  spec: BoardSpec,
  cardId: string
): { lane: BoardLane; index: number; card: BoardCard } {
  for (const lane of spec.lanes) {
    const index = lane.cards.findIndex((c) => c.id === cardId)
    if (index >= 0) return { lane, index, card: lane.cards[index]! }
  }
  throw new BoardError(`нет карточки ${cardId}`)
}

const clampIndex = (index: number | undefined, length: number): number =>
  index === undefined || !Number.isFinite(index) ? length : Math.min(length, Math.max(0, Math.round(index)))

const mapLane = (spec: BoardSpec, laneId: string, fn: (lane: BoardLane) => BoardLane): BoardSpec => ({
  ...spec,
  lanes: spec.lanes.map((l) => (l.id === laneId ? fn(l) : l))
})

/** Операции над доской — для людей и агентов одни и те же. */
export type BoardOp =
  | { op: 'rename'; title: string }
  | { op: 'add_lane'; title: string; index?: number; id?: string }
  | { op: 'rename_lane'; lane: string; title: string }
  | { op: 'move_lane'; lane: string; index: number }
  | { op: 'delete_lane'; lane: string }
  | { op: 'add_card'; lane: string; text: string; index?: number; color?: CanvasColor; id?: string }
  | { op: 'update_card'; card: string; text?: string; color?: CanvasColor | null }
  | { op: 'move_card'; card: string; lane: string; index?: number }
  | { op: 'delete_card'; card: string }

export function applyBoardOp(spec: BoardSpec, op: BoardOp): BoardSpec {
  switch (op.op) {
    case 'rename':
      return { ...spec, title: op.title.trim() || spec.title }
    case 'add_lane': {
      const lanes = [...spec.lanes]
      lanes.splice(clampIndex(op.index, lanes.length), 0, {
        id: op.id ?? newId(),
        title: op.title.trim() || 'Дорожка',
        cards: []
      })
      return { ...spec, lanes }
    }
    case 'rename_lane': {
      const lane = findLane(spec, op.lane)
      return mapLane(spec, lane.id, (l) => ({ ...l, title: op.title.trim() || l.title }))
    }
    case 'move_lane': {
      const lane = findLane(spec, op.lane)
      const lanes = spec.lanes.filter((l) => l.id !== lane.id)
      lanes.splice(clampIndex(op.index, lanes.length), 0, lane)
      return { ...spec, lanes }
    }
    case 'delete_lane': {
      const lane = findLane(spec, op.lane)
      return { ...spec, lanes: spec.lanes.filter((l) => l.id !== lane.id) }
    }
    case 'add_card': {
      const lane = findLane(spec, op.lane)
      const card: BoardCard = {
        id: op.id ?? newId(),
        text: op.text,
        ...(op.color ? { color: op.color } : {})
      }
      return mapLane(spec, lane.id, (l) => {
        const cards = [...l.cards]
        cards.splice(clampIndex(op.index, cards.length), 0, card)
        return { ...l, cards }
      })
    }
    case 'update_card': {
      const { lane, card } = findCard(spec, op.card)
      const next: BoardCard = { ...card, ...(op.text !== undefined ? { text: op.text } : {}) }
      if (op.color === null) delete next.color
      else if (op.color !== undefined) next.color = op.color
      return mapLane(spec, lane.id, (l) => ({
        ...l,
        cards: l.cards.map((c) => (c.id === card.id ? next : c))
      }))
    }
    case 'move_card': {
      const { card } = findCard(spec, op.card)
      const to = findLane(spec, op.lane)
      const without = removeCard(spec, card.id)
      return mapLane(without, to.id, (l) => {
        const cards = [...l.cards]
        cards.splice(clampIndex(op.index, cards.length), 0, card)
        return { ...l, cards }
      })
    }
    case 'delete_card':
      findCard(spec, op.card)
      return removeCard(spec, op.card)
  }
}

function removeCard(spec: BoardSpec, cardId: string): BoardSpec {
  return { ...spec, lanes: spec.lanes.map((l) => ({ ...l, cards: l.cards.filter((c) => c.id !== cardId) })) }
}

/** Агенты, соединённые с нодой связью в любую сторону. */
export function linkedAgents(doc: CanvasDoc, nodeId: string): string[] {
  const linked = new Set(
    doc.edges.flatMap((e) => (e.fromNode === nodeId ? [e.toNode] : e.toNode === nodeId ? [e.fromNode] : []))
  )
  return doc.nodes.filter((n) => linked.has(n.id) && isAgent(n)).map((n) => n.id)
}

/** Что случилось на доске — строками для письма агенту. Порядок внутри дорожки — не событие. */
export function boardEvents(before: BoardSpec, after: BoardSpec): string[] {
  const lines: string[] = []
  if (before.title !== after.title) lines.push(`~ доска переименована: «${before.title}» → «${after.title}»`)
  const laneBefore = new Map(before.lanes.map((l) => [l.id, l]))
  const laneAfter = new Map(after.lanes.map((l) => [l.id, l]))
  for (const lane of after.lanes) {
    const was = laneBefore.get(lane.id)
    if (!was) lines.push(`+ дорожка «${lane.title}»`)
    else if (was.title !== lane.title) lines.push(`~ дорожка «${was.title}» → «${lane.title}»`)
  }
  for (const lane of before.lanes) if (!laneAfter.has(lane.id)) lines.push(`− дорожка «${lane.title}»`)
  const order = (s: BoardSpec): string =>
    s.lanes
      .map((l) => l.id)
      .filter((id) => laneBefore.has(id) && laneAfter.has(id))
      .join()
  if (order(before) !== order(after))
    lines.push(`↔ порядок дорожек: ${after.lanes.map((l) => `«${l.title}»`).join(', ')}`)

  const where = (s: BoardSpec): Map<string, { lane: BoardLane; card: BoardCard }> =>
    new Map(s.lanes.flatMap((lane) => lane.cards.map((card) => [card.id, { lane, card }] as const)))
  const was = where(before)
  const now = where(after)
  const name = (card: BoardCard): string => `карточка «${cardTitle(card.text)}» (id ${card.id})`
  for (const [id, { lane, card }] of now) {
    const old = was.get(id)
    if (!old) {
      lines.push(`+ ${name(card)} в «${lane.title}»`)
      continue
    }
    if (old.lane.id !== lane.id) lines.push(`→ ${name(card)}: «${old.lane.title}» → «${lane.title}»`)
    const changes: string[] = []
    if (old.card.text !== card.text) changes.push('текст')
    if (old.card.color !== card.color) changes.push('цвет')
    if (changes.length) lines.push(`~ ${name(card)}: поменялся ${changes.join(' и ')}`)
  }
  for (const [id, { lane, card }] of was) if (!now.has(id)) lines.push(`− ${name(card)} из «${lane.title}»`)
  return lines
}

/** Письма агентам, соединённым с досками, о том, что на досках поменялось. */
export function boardNotices(
  before: CanvasDoc,
  after: CanvasDoc,
  skip: ReadonlySet<string> = new Set()
): { nodeId: string; text: string }[] {
  const old = new Map(before.nodes.map((n) => [n.id, n]))
  const byAgent = new Map<string, string[]>()
  for (const node of after.nodes) {
    const spec = boardSpec(node)
    const prev = old.get(node.id)
    const was = prev ? boardSpec(prev) : null
    if (!spec || !was) continue
    const lines = boardEvents(was, spec)
    if (!lines.length) continue
    for (const agent of linkedAgents(after, node.id)) {
      if (skip.has(agent)) continue
      const text = [`доска «${spec.title}» (id ${node.id}):`, ...lines].join('\n')
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), text])
    }
  }
  return [...byAgent].map(([nodeId, texts]) => ({ nodeId, text: texts.join('\n\n') }))
}
