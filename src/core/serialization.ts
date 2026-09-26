import {
  EDGE_KNOWN_KEYS,
  NODE_KNOWN_KEYS,
  ROOT_KNOWN_KEYS,
  type CanvasNodeType,
  type UnknownFields
} from '@shared/canvas'
import { NODE_TYPES, type CanvasDoc, type DocEdge, type DocNode } from './document'

export class CanvasParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanvasParseError'
  }
}

const HEAD: readonly string[] = ['id', 'type']
const BASE: readonly string[] = ['x', 'y', 'width', 'height', 'color']

// Obsidian пишет специфичные поля группы после геометрии, а у остальных типов — до неё.
function writeOrder(type: CanvasNodeType): readonly string[] {
  const own = NODE_KNOWN_KEYS[type].filter((k) => !HEAD.includes(k) && !BASE.includes(k))
  return type === 'group' ? [...HEAD, ...BASE, ...own] : [...HEAD, ...own, ...BASE]
}

const NODE_WRITE_ORDER: Readonly<Record<CanvasNodeType, readonly string[]>> = {
  text: writeOrder('text'),
  file: writeOrder('file'),
  link: writeOrder('link'),
  group: writeOrder('group')
}

function fields(raw: unknown, message: string): UnknownFields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CanvasParseError(message)
  return raw as UnknownFields
}

function split(raw: UnknownFields, known: readonly string[]): [UnknownFields, UnknownFields] {
  const kept: UnknownFields = {}
  const extra: UnknownFields = {}
  for (const [k, v] of Object.entries(raw)) (known.includes(k) ? kept : extra)[k] = v
  return [kept, extra]
}

function list(raw: unknown, name: string): unknown[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new CanvasParseError(`Поле "${name}" должно быть массивом`)
  return raw
}

function parseNode(raw: unknown): DocNode {
  const o = fields(raw, 'Нода должна быть объектом')
  const id = o['id']
  if (typeof id !== 'string') throw new CanvasParseError('У ноды отсутствует строковый "id"')
  const type = NODE_TYPES.find((t) => t === o['type'])
  if (!type) throw new CanvasParseError(`Нода ${id}: неизвестный тип "${String(o['type'])}"`)
  const [kept, extra] = split(o, NODE_KNOWN_KEYS[type])
  return { ...kept, extra } as unknown as DocNode
}

function parseEdge(raw: unknown): DocEdge {
  const o = fields(raw, 'Ребро должно быть объектом')
  if (typeof o['id'] !== 'string') throw new CanvasParseError('У ребра отсутствует строковый "id"')
  const [kept, extra] = split(o, EDGE_KNOWN_KEYS)
  return { ...kept, extra } as unknown as DocEdge
}

export function parseCanvas(text: string): CanvasDoc {
  if (text.trim() === '') return { nodes: [], edges: [], extra: {} }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new CanvasParseError(`Файл не является корректным JSON: ${e}`)
  }

  const root = fields(raw, 'Корень .canvas должен быть объектом')
  const nodes = list(root['nodes'], 'nodes').map(parseNode)
  const edges = list(root['edges'], 'edges').map(parseEdge)
  const [, extra] = split(root, ROOT_KNOWN_KEYS)
  return { nodes, edges, extra }
}

function compact(src: UnknownFields, known: readonly string[], extra: UnknownFields): string {
  const out: UnknownFields = {}
  for (const k of known) if (src[k] !== undefined) out[k] = src[k]
  for (const [k, v] of Object.entries(extra)) if (!known.includes(k)) out[k] = v
  return JSON.stringify(out)
}

function section(name: string, items: readonly string[]): string {
  if (items.length === 0) return `\t"${name}":[]`
  return `\t"${name}":[\n${items.map((i) => `\t\t${i}`).join(',\n')}\n\t]`
}

export function serializeCanvas(doc: CanvasDoc): string {
  const nodes = doc.nodes.map((n) =>
    compact(
      {
        ...n,
        x: Math.round(n.x),
        y: Math.round(n.y),
        width: Math.round(n.width),
        height: Math.round(n.height)
      },
      NODE_WRITE_ORDER[n.type],
      n.extra
    )
  )
  const edges = doc.edges.map((e) => compact({ ...e }, EDGE_KNOWN_KEYS, e.extra))
  const rest = Object.entries(doc.extra)
    .filter(([k]) => !ROOT_KNOWN_KEYS.includes(k))
    .map(([k, v]) => `\t${JSON.stringify(k)}:${JSON.stringify(v)}`)
  return `{\n${[section('nodes', nodes), section('edges', edges), ...rest].join(',\n')}\n}`
}
