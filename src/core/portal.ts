import type { CanvasDoc, DocNode } from './document'
import { nodeName, nodeRole } from './node-name'
import { terminalSpec } from './terminal'

/**
 * Портал — дверь между двумя cnv: на обеих сторонах открыт портал с одним ключом, и
 * агенты, подключённые к своему порталу стрелками, говорят с агентами на той стороне.
 * Хранится в обычной текстовой ноде с пометкой `x-cnv.portal` — Obsidian покажет карточку.
 *
 * Ключ лежит в `.canvas`: файлом не делимся. Доверенные cnv той стороны — по отпечатку их
 * ключа устройства: подтвердил один раз — дальше пускаем без вопросов.
 */
export interface PortalSpec {
  key: string
  /** Подпись портала: «Ноутбук Пети». */
  label?: string
  /** cnv той стороны, которым человек разрешил войти. */
  trusted: TrustedPeer[]
}

export interface TrustedPeer {
  fingerprint: string
  name: string
  /** Когда разрешили (мс). */
  at: number
}

const KEY = 'x-cnv'
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

export function portalSpec(node: DocNode): PortalSpec | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  const p = isRecord(own) ? own.portal : undefined
  if (!isRecord(p) || typeof p.key !== 'string') return null
  const trusted = Array.isArray(p.trusted)
    ? p.trusted.filter(
        (t): t is TrustedPeer =>
          isRecord(t) &&
          typeof t.fingerprint === 'string' &&
          typeof t.name === 'string' &&
          typeof t.at === 'number'
      )
    : []
  return { key: p.key, ...(typeof p.label === 'string' && p.label ? { label: p.label } : {}), trusted }
}

export const isPortal = (node: DocNode): boolean => portalSpec(node) !== null

export function withPortalSpec(
  extra: Record<string, unknown>,
  spec: Partial<PortalSpec>
): Record<string, unknown> {
  const own = isRecord(extra[KEY]) ? (extra[KEY] as Record<string, unknown>) : {}
  const prev = isRecord(own.portal) ? own.portal : {}
  return { ...extra, [KEY]: { ...own, portal: { ...prev, ...spec } } }
}

/** Алфавит ключа: без похожих символов (0/O, 1/I/L) — ключ диктуют и переписывают руками. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Новый ключ: 4 группы по 4 знака, ~80 бит — подобрать нельзя, продиктовать можно. */
export function newPortalKey(random: (n: number) => Uint8Array): string {
  const bytes = random(16)
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]!)
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

/** Ключ из ввода человека: регистр, пробелы и тире не важны. */
export function normalizePortalKey(input: string): string {
  return input.trim().replace(/\s+/g, '-')
}

/** Текст карточки — то, что увидит Obsidian, открыв наш канвас. */
export const portalPlaceholder = (label?: string): string => `\`портал${label ? ` «${label}»` : ''}\``

export interface PortalMember {
  /** id ноды на этой стороне. */
  id: string
  name: string
  role?: string
  kind: 'agent' | 'terminal'
}

/**
 * Кого видно через портал с той стороны: агенты и терминалы, соединённые с порталом
 * стрелкой (в любую сторону). Остальной холст — частный: его через портал не видно.
 */
export function portalMembers(doc: CanvasDoc, portalId: string): PortalMember[] {
  const linked = new Set(
    doc.edges.flatMap((e) =>
      e.fromNode === portalId ? [e.toNode] : e.toNode === portalId ? [e.fromNode] : []
    )
  )
  const out: PortalMember[] = []
  for (const node of doc.nodes) {
    if (!linked.has(node.id)) continue
    const spec = terminalSpec(node)
    if (!spec) continue
    const role = nodeRole(node)
    out.push({
      id: node.id,
      name: nodeName(node) ?? node.id,
      ...(role ? { role } : {}),
      kind: spec.agent ? 'agent' : 'terminal'
    })
  }
  return out
}

/** Портал, через который нода (агент) достаёт до той стороны: стрелка между ними есть. */
export function portalsOf(doc: CanvasDoc, nodeId: string): DocNode[] {
  const linked = new Set(
    doc.edges.flatMap((e) => (e.fromNode === nodeId ? [e.toNode] : e.toNode === nodeId ? [e.fromNode] : []))
  )
  return doc.nodes.filter((n) => linked.has(n.id) && isPortal(n))
}

/** Отпечаток для людей: «AB12-CD34-EF56». */
export const formatFingerprint = (hex: string): string =>
  hex
    .slice(0, 12)
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1-')

/**
 * Сколько ждать подтверждения доставки — от момента, когда письмо целиком ушло в канал:
 * база плюс запас на то, что та сторона дособирает и запишет вложения.
 */
const ACK_TIMEOUT_MS = 10_000
const ACK_MS_PER_MB = 4_000

export const ackTimeoutMs = (bytes: number): number =>
  ACK_TIMEOUT_MS + Math.ceil((bytes / 1_000_000) * ACK_MS_PER_MB)
