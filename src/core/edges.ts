import type { NodeSide } from '@shared/canvas'
import { isGroup, type CanvasDoc, type DocEdge, type DocNode } from './document'
import { visualBounds } from './image-edit'
import { nearestSide, rectsIntersect, sideAnchor, type Point, type Rect } from './geometry'

export interface EdgeGeometry {
  from: Point
  to: Point
  path: string
  /** Точка для подписи — середина кривой. */
  labelAt: Point
  /** Управляющие точки кривой Безье — для выборки точек вдоль неё. */
  c1: Point
  c2: Point
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

/**
 * Стороны по умолчанию — те, что смотрят друг на друга. Если ноды разнесены зазором, стрелка
 * идёт через зазор пошире: по горизонтали (справа налево) или по вертикали (снизу вверх).
 * Иначе у дерева слева направо стрелка к верхнему ребёнку выходила бы из верха родителя и
 * резала соседей по колонке.
 */
export function defaultSides(from: Rect, to: Rect): { fromSide: NodeSide; toSide: NodeSide } {
  const hgap = Math.max(to.x - (from.x + from.width), from.x - (to.x + to.width))
  const vgap = Math.max(to.y - (from.y + from.height), from.y - (to.y + to.height))
  if (hgap > 0 && hgap >= vgap) {
    return to.x > from.x ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  if (vgap > 0) {
    return to.y > from.y ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
  }
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  return { fromSide: nearestSide(from, toCenter), toSide: nearestSide(to, fromCenter) }
}

export function edgeGeometry(from: Rect, to: Rect, fromSide?: NodeSide, toSide?: NodeSide): EdgeGeometry {
  const sides = defaultSides(from, to)
  const a = fromSide ?? sides.fromSide
  const b = toSide ?? sides.toSide
  return curve(sideAnchor(from, a), a, sideAnchor(to, b), b)
}

/** Кривая между двумя точками на сторонах: ручки смотрят наружу из своих сторон. */
function curve(start: Point, a: NodeSide, end: Point, b: NodeSide): EdgeGeometry {
  const distance = Math.hypot(end.x - start.x, end.y - start.y)
  const handle = Math.max(MIN_HANDLE, distance * HANDLE_RATIO)
  const c1 = { x: start.x + OUTWARD[a].x * handle, y: start.y + OUTWARD[a].y * handle }
  const c2 = { x: end.x + OUTWARD[b].x * handle, y: end.y + OUTWARD[b].y * handle }

  return {
    from: start,
    to: end,
    fromSide: a,
    toSide: b,
    c1,
    c2,
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelAt: cubicAt(start, c1, c2, end, 0.5)
  }
}

const SIDES: readonly NodeSide[] = ['top', 'right', 'bottom', 'left']
/** Насколько дороже кусок кривой сквозь чужую ноду, чем по пустому холсту. */
const THROUGH_NODE = 2.5
/** Пара сторон «лицом друг к другу» выигрывает спорные случаи: так привычнее глазу. */
const FACING_BONUS = 0.9
const COST_SAMPLES = 16
/** Отступ вокруг чужих нод: кривая, царапающая край, тоже мешает. */
const OBSTACLE_MARGIN = 8

/**
 * Стороны с самой короткой и чистой кривой: перебираем все 16 пар, цена — длина кривой
 * плюс штраф за куски сквозь другие ноды. Длина сама гасит S-петли: дуга вниз-вбок-вниз
 * к соседу справа длиннее, чем выход сбоку. Без препятствий — те же стороны, что и
 * `defaultSides`, кроме случаев, где выход сбоку заметно короче.
 */
export function bestSides(
  from: Rect,
  to: Rect,
  obstacles: readonly Rect[] = []
): { fromSide: NodeSide; toSide: NodeSide } {
  const facing = defaultSides(from, to)
  let best = facing
  let bestCost = Infinity
  for (const a of SIDES) {
    for (const b of SIDES) {
      const g = curve(sideAnchor(from, a), a, sideAnchor(to, b), b)
      let cost = curveCost(g, obstacles, [from, to])
      if (a === facing.fromSide && b === facing.toSide) cost *= FACING_BONUS
      if (cost < bestCost) {
        bestCost = cost
        best = { fromSide: a, toSide: b }
      }
    }
  }
  return best
}

/** `own` — сами концы: кривая не должна заходить в свою же ноду, огибая её с тыла. */
function curveCost(g: EdgeGeometry, obstacles: readonly Rect[], own: readonly Rect[]): number {
  let cost = 0
  let prev = g.from
  for (let i = 1; i <= COST_SAMPLES; i++) {
    const p = cubicAt(g.from, g.c1, g.c2, g.to, i / COST_SAMPLES)
    const length = Math.hypot(p.x - prev.x, p.y - prev.y)
    const mid = { x: (p.x + prev.x) / 2, y: (p.y + prev.y) / 2 }
    const blocked =
      obstacles.some((o) => inside(o, mid, OBSTACLE_MARGIN)) || own.some((o) => inside(o, mid, 0))
    cost += blocked ? length * THROUGH_NODE : length
    prev = p
  }
  return cost
}

const inside = (r: Rect, p: Point, margin: number): boolean =>
  p.x > r.x - margin && p.x < r.x + r.width + margin && p.y > r.y - margin && p.y < r.y + r.height + margin

/** Ноды, через которые кривая между `from` и `to` вообще может пройти. */
function nearbyObstacles(
  from: Rect,
  to: Rect,
  all: readonly { id: string; rect: Rect }[],
  skip: readonly string[]
): Rect[] {
  const x = Math.min(from.x, to.x)
  const y = Math.min(from.y, to.y)
  const right = Math.max(from.x + from.width, to.x + to.width)
  const bottom = Math.max(from.y + from.height, to.y + to.height)
  // Ручки кривой выносят её за общий бокс — на долю расстояния, как и в `curve`.
  const pad = Math.max(MIN_HANDLE, Math.hypot(right - x, bottom - y) * HANDLE_RATIO)
  const area = { x: x - pad, y: y - pad, width: right - x + 2 * pad, height: bottom - y + 2 * pad }
  return all.filter((o) => !skip.includes(o.id) && rectsIntersect(o.rect, area)).map((o) => o.rect)
}

/** Самый большой шаг между соседними концами на одной стороне. */
const PORT_GAP = 36
/** Концы держатся в средней части стороны, не съезжая к углам. */
const PORT_SPAN = 0.7

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
 * `autoSides` — стороны подбираются по текущему расположению нод (в обход чужих нод), а
 * записанные в файле игнорируются. Иначе связь, у которой ноды поменяли местами,
 * продолжает уходить в старую сторону и огибает их кругом.
 *
 * Если из одной стороны выходит несколько связей, концы разводятся вдоль неё по порядку
 * направлений — без «веника» из одной точки и без перекрёстков у самой ноды. В файл это не
 * пишется: в JSON Canvas у связи есть только сторона.
 */
export function resolveEdges(doc: CanvasDoc, autoSides = false): ResolvedEdge[] {
  const byId = new Map<string, DocNode>(doc.nodes.map((n) => [n.id, n]))
  // Связи цепляются к видимым границам — у повёрнутой картинки это AABB, а не хранимый бокс.
  const rects = new Map<string, Rect>(doc.nodes.map((n) => [n.id, visualBounds(n)]))
  const obstacles = autoSides
    ? doc.nodes.filter((n) => !isGroup(n)).map((n) => ({ id: n.id, rect: rects.get(n.id) as Rect }))
    : []

  interface Routed {
    edge: DocEdge
    fromRect: Rect
    toRect: Rect
    fromSide: NodeSide
    toSide: NodeSide
  }
  const routed: Routed[] = []
  for (const edge of doc.edges) {
    // Ребро в никуда — это битый файл, а не наш случай: просто не рисуем.
    if (!byId.has(edge.fromNode) || !byId.has(edge.toNode)) continue
    const fromRect = rects.get(edge.fromNode) as Rect
    const toRect = rects.get(edge.toNode) as Rect
    const sides = autoSides
      ? bestSides(
          fromRect,
          toRect,
          nearbyObstacles(fromRect, toRect, obstacles, [edge.fromNode, edge.toNode])
        )
      : {
          fromSide: edge.fromSide ?? defaultSides(fromRect, toRect).fromSide,
          toSide: edge.toSide ?? defaultSides(fromRect, toRect).toSide
        }
    routed.push({ edge, fromRect, toRect, ...sides })
  }

  const anchors = spreadPorts(routed)
  return routed.map((r, i) => {
    const [start, end] = anchors[i] as [Point, Point]
    return { edge: r.edge, geometry: curve(start, r.fromSide, end, r.toSide) }
  })
}

/**
 * Точки концов: одиночный конец — середина стороны, несколько на одной стороне — в ряд,
 * упорядоченный по тому, куда каждый смотрит (по другой ноде вдоль этой стороны).
 */
function spreadPorts(
  routed: readonly { edge: DocEdge; fromRect: Rect; toRect: Rect; fromSide: NodeSide; toSide: NodeSide }[]
): [Point, Point][] {
  const out: [Point, Point][] = routed.map((r) => [
    sideAnchor(r.fromRect, r.fromSide),
    sideAnchor(r.toRect, r.toSide)
  ])
  interface End {
    edge: number
    end: 0 | 1
    order: number
  }
  const groups = new Map<string, { rect: Rect; side: NodeSide; ends: End[] }>()
  const add = (node: string, rect: Rect, side: NodeSide, end: End): void => {
    const key = `${node}:${side}`
    const group = groups.get(key) ?? { rect, side, ends: [] }
    group.ends.push(end)
    groups.set(key, group)
  }
  routed.forEach((r, i) => {
    const toward = (rect: Rect, side: NodeSide, other: Rect): number => {
      const horizontal = side === 'top' || side === 'bottom'
      const center = horizontal ? other.x + other.width / 2 : other.y + other.height / 2
      return center - (horizontal ? rect.x + rect.width / 2 : rect.y + rect.height / 2)
    }
    add(r.edge.fromNode, r.fromRect, r.fromSide, {
      edge: i,
      end: 0,
      order: toward(r.fromRect, r.fromSide, r.toRect)
    })
    add(r.edge.toNode, r.toRect, r.toSide, { edge: i, end: 1, order: toward(r.toRect, r.toSide, r.fromRect) })
  })

  for (const { rect, side, ends } of groups.values()) {
    if (ends.length < 2) continue
    ends.sort((a, b) => a.order - b.order || a.edge - b.edge)
    const horizontal = side === 'top' || side === 'bottom'
    const length = horizontal ? rect.width : rect.height
    const step = Math.min(PORT_GAP, (length * PORT_SPAN) / (ends.length - 1))
    const first = -(step * (ends.length - 1)) / 2
    ends.forEach((e, k) => {
      const base = (out[e.edge] as [Point, Point])[e.end]
      const shift = first + step * k
      ;(out[e.edge] as [Point, Point])[e.end] = horizontal
        ? { x: base.x + shift, y: base.y }
        : { x: base.x, y: base.y + shift }
    })
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

/** Точки вдоль кривой связи, включая концы. */
export function edgeSamples(g: EdgeGeometry, samples = 24): Point[] {
  return Array.from({ length: samples + 1 }, (_, i) => cubicAt(g.from, g.c1, g.c2, g.to, i / samples))
}

/** Расстояние от точки до кривой — для попадания клика по ребру. */
export function distanceToEdge(geometry: EdgeGeometry, point: Point, samples = 24): number {
  let best = Infinity
  let prev = geometry.from
  for (let i = 1; i <= samples; i++) {
    const current = cubicAt(geometry.from, geometry.c1, geometry.c2, geometry.to, i / samples)
    best = Math.min(best, distanceToSegment(point, prev, current))
    prev = current
  }
  return best
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
