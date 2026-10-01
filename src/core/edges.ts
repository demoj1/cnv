import type { NodeSide } from '@shared/canvas'
import type { CanvasDoc, DocEdge, DocNode } from './document'
import { visualBounds } from './image-edit'
import { nearestSide, sideAnchor, type Point, type Rect } from './geometry'

export interface EdgeGeometry {
  from: Point
  to: Point
  path: string
  /** Точка для подписи — середина кривой. */
  labelAt: Point
  fromSide: NodeSide
  toSide: NodeSide
}

const OUTWARD: Record<NodeSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 }
}

const MIN_HANDLE = 40
const HANDLE_RATIO = 0.4

/** Стороны по умолчанию — те, что смотрят друг на друга. */
export function defaultSides(from: Rect, to: Rect): { fromSide: NodeSide; toSide: NodeSide } {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  return { fromSide: nearestSide(from, toCenter), toSide: nearestSide(to, fromCenter) }
}

export function edgeGeometry(from: Rect, to: Rect, fromSide?: NodeSide, toSide?: NodeSide): EdgeGeometry {
  const sides = defaultSides(from, to)
  const a = fromSide ?? sides.fromSide
  const b = toSide ?? sides.toSide
  const start = sideAnchor(from, a)
  const end = sideAnchor(to, b)

  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const handle = Math.max(MIN_HANDLE, distance * HANDLE_RATIO)
  const c1 = { x: start.x + OUTWARD[a].x * handle, y: start.y + OUTWARD[a].y * handle }
  const c2 = { x: end.x + OUTWARD[b].x * handle, y: end.y + OUTWARD[b].y * handle }

  return {
    from: start,
    to: end,
    fromSide: a,
    toSide: b,
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelAt: cubicAt(start, c1, c2, end, 0.5)
  }
}

export function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  }
}

/** Угол выхода стрелки на конце, в градусах — для поворота маркера. */
export function endAngle(side: NodeSide): number {
  switch (side) {
    case 'top':
      return -90
    case 'right':
      return 0
    case 'bottom':
      return 90
    case 'left':
      return 180
  }
}

export interface ResolvedEdge {
  edge: DocEdge
  geometry: EdgeGeometry
}

/**
 * `autoSides` — стороны подбираются по текущему расположению нод, а записанные в файле
 * игнорируются. Иначе связь, у которой ноды поменяли местами, продолжает уходить
 * в старую сторону и огибает их кругом.
 */
export function resolveEdges(doc: CanvasDoc, autoSides = false): ResolvedEdge[] {
  const byId = new Map<string, DocNode>(doc.nodes.map((n) => [n.id, n]))
  const out: ResolvedEdge[] = []
  for (const edge of doc.edges) {
    const from = byId.get(edge.fromNode)
    const to = byId.get(edge.toNode)
    // Ребро в никуда — это битый файл, а не наш случай: просто не рисуем.
    if (!from || !to) continue
    // Связи цепляются к видимым границам — у повёрнутой картинки это AABB, а не хранимый бокс.
    const fromRect = visualBounds(from)
    const toRect = visualBounds(to)
    const geometry = autoSides
      ? edgeGeometry(fromRect, toRect)
      : edgeGeometry(fromRect, toRect, edge.fromSide, edge.toSide)
    out.push({ edge, geometry })
  }
  return out
}

/**
 * Стороны, которые надо записать в документ, чтобы файл совпадал с тем, что на экране
 * (и так же открывался в Obsidian). Возвращает только реально разошедшиеся связи.
 */
export function staleEdgeSides(doc: CanvasDoc): Map<string, { fromSide: NodeSide; toSide: NodeSide }> {
  const changed = new Map<string, { fromSide: NodeSide; toSide: NodeSide }>()
  for (const { edge, geometry } of resolveEdges(doc, true)) {
    if (edge.fromSide === geometry.fromSide && edge.toSide === geometry.toSide) continue
    changed.set(edge.id, { fromSide: geometry.fromSide, toSide: geometry.toSide })
  }
  return changed
}

/** Расстояние от точки до кривой — для попадания клика по ребру. */
export function distanceToEdge(geometry: EdgeGeometry, point: Point, samples = 24): number {
  let best = Infinity
  let prev = geometry.from
  for (let i = 1; i <= samples; i++) {
    const current = pointOnPath(geometry, i / samples)
    best = Math.min(best, distanceToSegment(point, prev, current))
    prev = current
  }
  return best
}

function pointOnPath(geometry: EdgeGeometry, t: number): Point {
  const distance = Math.hypot(geometry.to.x - geometry.from.x, geometry.to.y - geometry.from.y)
  const handle = Math.max(MIN_HANDLE, distance * HANDLE_RATIO)
  const c1 = {
    x: geometry.from.x + OUTWARD[geometry.fromSide].x * handle,
    y: geometry.from.y + OUTWARD[geometry.fromSide].y * handle
  }
  const c2 = {
    x: geometry.to.x + OUTWARD[geometry.toSide].x * handle,
    y: geometry.to.y + OUTWARD[geometry.toSide].y * handle
  }
  return cubicAt(geometry.from, c1, c2, geometry.to, t)
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
