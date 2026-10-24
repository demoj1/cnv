import type { NodeSide } from '@shared/canvas'
import { edgeGeometry, edgeSamples } from './edges'
import { rectsIntersect, type Point, type Rect } from './geometry'

/**
 * Раскладки для агентов: расставить набор нод сеткой, рядом, столбцом, кругом вокруг
 * корня или деревом по связям — одним шагом, а не сотней update_node. Порядок там, где он
 * не задан связями, — как ноды уже стоят: сверху вниз, слева направо.
 */
export type LayoutMode = 'grid' | 'row' | 'column' | 'radial' | 'tree'

export interface LayoutItem {
  id: string
  rect: Rect
}

export interface LayoutOptions {
  mode: LayoutMode
  gap: number
  /** Корень для radial и tree; нет — первый id (radial) или нода без входящих связей (tree). */
  root?: string
  /** Левый верхний угол раскладки; нет — где сейчас левый верхний угол набора. */
  origin?: Point
  /** Сетка: сколько столбцов; нет — квадратная. */
  columns?: number
}

const readingOrder = (a: LayoutItem, b: LayoutItem): number => a.rect.y - b.rect.y || a.rect.x - b.rect.x

export function layoutRects(
  items: readonly LayoutItem[],
  edges: readonly { fromNode: string; toNode: string }[],
  options: LayoutOptions
): Map<string, Rect> {
  const out = new Map<string, Rect>()
  if (items.length === 0) return out
  const gap = Math.max(0, options.gap)
  const origin = options.origin ?? {
    x: Math.min(...items.map((i) => i.rect.x)),
    y: Math.min(...items.map((i) => i.rect.y))
  }
  const sorted = [...items].sort(readingOrder)
  const put = (item: LayoutItem, x: number, y: number): void => {
    out.set(item.id, { ...item.rect, x: Math.round(x), y: Math.round(y) })
  }

  switch (options.mode) {
    case 'row': {
      let x = origin.x
      for (const item of [...items].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y)) {
        put(item, x, origin.y)
        x += item.rect.width + gap
      }
      return out
    }
    case 'column': {
      let y = origin.y
      for (const item of sorted) {
        put(item, origin.x, y)
        y += item.rect.height + gap
      }
      return out
    }
    case 'grid': {
      const cols = Math.max(1, options.columns ?? Math.ceil(Math.sqrt(items.length)))
      const rows = Math.ceil(items.length / cols)
      const colW = Array.from({ length: cols }, (_, c) =>
        Math.max(0, ...sorted.filter((_, i) => i % cols === c).map((i) => i.rect.width))
      )
      const rowH = Array.from({ length: rows }, (_, r) =>
        Math.max(0, ...sorted.slice(r * cols, r * cols + cols).map((i) => i.rect.height))
      )
      sorted.forEach((item, i) => {
        const c = i % cols
        const r = Math.floor(i / cols)
        const x = origin.x + colW.slice(0, c).reduce((s, w) => s + w + gap, 0)
        const y = origin.y + rowH.slice(0, r).reduce((s, h) => s + h + gap, 0)
        put(item, x, y)
      })
      return out
    }
    case 'radial': {
      const root = items.find((i) => i.id === options.root) ?? items[0]!
      const rest = sorted.filter((i) => i !== root)
      const cx = root.rect.x + root.rect.width / 2
      const cy = root.rect.y + root.rect.height / 2
      out.set(root.id, root.rect)
      if (rest.length === 0) return out
      // Радиус: чтобы соседи на круге не налезали друг на друга и на корень.
      const biggest = Math.max(...rest.map((i) => Math.hypot(i.rect.width, i.rect.height)))
      const rootSize = Math.hypot(root.rect.width, root.rect.height)
      const ring = rest.reduce((s, i) => s + Math.max(i.rect.width, i.rect.height) + gap, 0)
      const radius = Math.max(rootSize / 2 + biggest / 2 + gap, ring / (2 * Math.PI))
      rest.forEach((item, i) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * i) / rest.length
        put(
          item,
          cx + radius * Math.cos(angle) - item.rect.width / 2,
          cy + radius * Math.sin(angle) - item.rect.height / 2
        )
      })
      return out
    }
    case 'tree':
      return treeLayout(items, edges, options.root, origin, gap, out)
  }
}

/** Дерево слева направо: уровни — столбцы, родитель — посередине своих детей. */
function treeLayout(
  items: readonly LayoutItem[],
  edges: readonly { fromNode: string; toNode: string }[],
  rootId: string | undefined,
  origin: Point,
  gap: number,
  out: Map<string, Rect>
): Map<string, Rect> {
  const byId = new Map(items.map((i) => [i.id, i]))
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  for (const e of edges) {
    if (!byId.has(e.fromNode) || !byId.has(e.toNode) || e.fromNode === e.toNode) continue
    children.set(e.fromNode, [...(children.get(e.fromNode) ?? []), e.toNode])
    hasParent.add(e.toNode)
  }
  const order = (ids: string[]): string[] =>
    ids
      .map((id) => byId.get(id)!)
      .sort(readingOrder)
      .map((i) => i.id)

  const roots = rootId && byId.has(rootId) ? [rootId] : []
  for (const i of [...items].sort(readingOrder)) {
    if (!hasParent.has(i.id) && !roots.includes(i.id)) roots.push(i.id)
  }

  // Обход в ширину: у каждой ноды один родитель (первый, кто до неё дотянулся), циклы рвутся.
  const depth = new Map<string, number>()
  const kids = new Map<string, string[]>()
  const visit = (start: string): void => {
    if (depth.has(start)) return
    depth.set(start, 0)
    const queue = [start]
    while (queue.length > 0) {
      const id = queue.shift()!
      const mine: string[] = []
      for (const child of order(children.get(id) ?? [])) {
        if (depth.has(child)) continue
        depth.set(child, depth.get(id)! + 1)
        mine.push(child)
        queue.push(child)
      }
      kids.set(id, mine)
    }
  }
  for (const r of roots) visit(r)
  // Недостижимые (например, в цикле без корня) — отдельными деревьями.
  for (const i of items) visit(i.id)

  const maxDepth = Math.max(...depth.values())
  const colW = Array.from({ length: maxDepth + 1 }, (_, d) =>
    Math.max(0, ...items.filter((i) => depth.get(i.id) === d).map((i) => i.rect.width))
  )
  const colX = colW.map((_, d) => origin.x + colW.slice(0, d).reduce((s, w) => s + w + gap * 2, 0))

  let cursor = origin.y
  /** Ставит поддерево и возвращает центр его корня по вертикали. */
  const place = (id: string): number => {
    const item = byId.get(id)!
    const childIds = kids.get(id) ?? []
    let centerY: number
    if (childIds.length === 0) {
      centerY = cursor + item.rect.height / 2
      cursor += item.rect.height + gap
    } else {
      const centers = childIds.map(place)
      centerY = (centers[0]! + centers[centers.length - 1]!) / 2
      // Высокий родитель не должен налезть на следующее поддерево.
      cursor = Math.max(cursor, centerY + item.rect.height / 2 + gap)
    }
    out.set(id, {
      ...item.rect,
      x: Math.round(colX[depth.get(id)!]!),
      y: Math.round(centerY - item.rect.height / 2)
    })
    return centerY
  }
  for (const r of roots) if (depth.get(r) === 0 && !out.has(r)) place(r)
  for (const i of items) if (!out.has(i.id)) place(i.id)
  return out
}

export interface OverlapNode {
  id: string
  kind: string
  rect: Rect
}

/** Пары нод, которые налезают друг на друга. Группы — рамки, их не считаем. */
export function findOverlaps(nodes: readonly OverlapNode[]): [string, string][] {
  const solid = nodes.filter((n) => n.kind !== 'group')
  const out: [string, string][] = []
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      if (rectsIntersect(solid[i]!.rect, solid[j]!.rect)) out.push([solid[i]!.id, solid[j]!.id])
    }
  }
  return out
}

/** Связи, которые проходят сквозь чужие ноды (не свои концы): стрелку там не разглядеть. */
export function edgeCrossings(
  nodes: readonly OverlapNode[],
  edges: readonly { id: string; fromNode: string; toNode: string; fromSide?: NodeSide; toSide?: NodeSide }[]
): { edge: string; nodes: string[] }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const solid = nodes.filter((n) => n.kind !== 'group')
  const out: { edge: string; nodes: string[] }[] = []
  for (const e of edges) {
    const from = byId.get(e.fromNode)
    const to = byId.get(e.toNode)
    if (!from || !to) continue
    // Концы кривой лежат на краях своих нод — их пропускаем, иначе «пересекает» всегда.
    const points = edgeSamples(edgeGeometry(from.rect, to.rect, e.fromSide, e.toSide), 32).slice(1, -1)
    const hit = solid
      .filter((n) => n.id !== e.fromNode && n.id !== e.toNode)
      .filter((n) =>
        points.some(
          (p) =>
            p.x > n.rect.x &&
            p.x < n.rect.x + n.rect.width &&
            p.y > n.rect.y &&
            p.y < n.rect.y + n.rect.height
        )
      )
      .map((n) => n.id)
    if (hit.length > 0) out.push({ edge: e.id, nodes: hit })
  }
  return out
}
