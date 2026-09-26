import { expandRect, rectBottom, rectCenterX, rectCenterY, rectRight, rectsIntersect } from './geometry'
import type { Point, Rect } from './geometry'
import type { ResizeHandle } from './transform'

export type GuideAxis = 'x' | 'y'

/** Линия-направляющая в МИРОВЫХ координатах; рисуется в оверлее. */
export interface Guide {
  axis: GuideAxis
  /** Координата линии: для axis 'x' — это x, для 'y' — y. */
  position: number
  /** Отрезок, вдоль которого рисовать линию (от/до по другой оси). */
  from: number
  to: number
  /** Что совпало: край, центр или равный отступ. */
  kind: 'edge' | 'center' | 'spacing'
}

export interface SnapSettings {
  /** Привязка к сетке. */
  grid: boolean
  gridSize: number
  /** Смарт-направляющие по краям и центрам соседей. */
  smartGuides: boolean
  /** Привязка к равным отступам между нодами. */
  equalSpacing: boolean
  /** Порог срабатывания в ЭКРАННЫХ пикселях. */
  thresholdPx: number
  /** Текущий zoom камеры — порог в мировых единицах равен thresholdPx / zoom. */
  zoom: number
}

export interface SnapResult {
  /** Итоговый прямоугольник после привязки. */
  rect: Rect
  /** Насколько подвинули относительно входного rect. */
  delta: Point
  guides: Guide[]
}

const EPS = 1e-9

const RANK_EDGE = 0
const RANK_CENTER = 1
const RANK_EDGE_TO_CENTER = 2
const RANK_SPACING = 3
const RANK_GRID = 4

type Role = 'start' | 'center' | 'end'

const ROLES: readonly Role[] = ['start', 'center', 'end']

interface AxisGeometry {
  at: Record<Role, (r: Rect) => number>
  size: (r: Rect) => number
  place: (r: Rect, start: number, size: number) => Rect
}

const AXES: Record<GuideAxis, AxisGeometry> = {
  x: {
    at: { start: (r) => r.x, center: rectCenterX, end: rectRight },
    size: (r) => r.width,
    place: (r, start, size) => ({ ...r, x: start, width: size })
  },
  y: {
    at: { start: (r) => r.y, center: rectCenterY, end: rectBottom },
    size: (r) => r.height,
    place: (r, start, size) => ({ ...r, y: start, height: size })
  }
}

const AXIS_ORDER: readonly GuideAxis[] = ['x', 'y']

const OTHER_AXIS: Record<GuideAxis, GuideAxis> = { x: 'y', y: 'x' }

type AxisOp = { mode: 'move' } | { mode: 'edge'; role: 'start' | 'end' } | { mode: 'frozen' }

const MOVE: AxisOp = { mode: 'move' }
const EDGE_START: AxisOp = { mode: 'edge', role: 'start' }
const EDGE_END: AxisOp = { mode: 'edge', role: 'end' }
const FROZEN: AxisOp = { mode: 'frozen' }

const HANDLE_OPS: Record<ResizeHandle, Record<GuideAxis, AxisOp>> = {
  nw: { x: EDGE_START, y: EDGE_START },
  n: { x: FROZEN, y: EDGE_START },
  ne: { x: EDGE_END, y: EDGE_START },
  e: { x: EDGE_END, y: FROZEN },
  se: { x: EDGE_END, y: EDGE_END },
  s: { x: FROZEN, y: EDGE_END },
  sw: { x: EDGE_START, y: EDGE_END },
  w: { x: EDGE_START, y: FROZEN }
}

interface Line {
  position: number
  rank: number
  rects: Rect[]
}

interface AxisMatch {
  offset: number
  rank: number
  lines: Line[]
}

interface Ranked {
  offset: number
  rank: number
}

const better = (challenger: Ranked, champion: Ranked | null): boolean => {
  if (champion === null) return true
  const diff = Math.abs(challenger.offset) - Math.abs(champion.offset)
  return diff < -EPS || (diff <= EPS && challenger.rank < champion.rank)
}

function alignMatch(
  rect: Rect,
  others: readonly Rect[],
  axis: GuideAxis,
  roles: readonly Role[],
  threshold: number
): AxisMatch | null {
  const g = AXES[axis]
  const hits: (Ranked & { position: number; rect: Rect })[] = []
  for (const other of others) {
    for (const role of roles) {
      const moving = g.at[role](rect)
      for (const target of ROLES) {
        const position = g.at[target](other)
        const offset = position - moving
        if (Math.abs(offset) > threshold) continue
        const centers = (role === 'center' ? 1 : 0) + (target === 'center' ? 1 : 0)
        const rank = centers === 0 ? RANK_EDGE : centers === 2 ? RANK_CENTER : RANK_EDGE_TO_CENTER
        hits.push({ offset, rank, position, rect: other })
      }
    }
  }

  let best: Ranked | null = null
  for (const hit of hits) {
    if (better(hit, best)) best = hit
  }
  if (best === null) return null

  const lines: Line[] = []
  for (const hit of hits) {
    if (Math.abs(hit.offset - best.offset) > EPS) continue
    const line = lines.find((l) => Math.abs(l.position - hit.position) <= EPS)
    if (line === undefined) {
      lines.push({ position: hit.position, rank: hit.rank, rects: [hit.rect] })
      continue
    }
    if (!line.rects.includes(hit.rect)) line.rects.push(hit.rect)
    line.rank = Math.min(line.rank, hit.rank)
  }
  return { offset: best.offset, rank: best.rank, lines }
}

function spacingMatch(
  rect: Rect,
  others: readonly Rect[],
  axis: GuideAxis,
  threshold: number
): AxisMatch | null {
  const g = AXES[axis]
  const across = AXES[OTHER_AXIS[axis]]
  const row = others.filter(
    (o) => across.at.start(o) < across.at.end(rect) && across.at.end(o) > across.at.start(rect)
  )
  const size = g.size(rect)
  const start = g.at.start(rect)

  let best: AxisMatch | null = null
  for (const left of row) {
    for (const right of row) {
      if (left === right) continue
      const free = g.at.start(right) - g.at.end(left) - size
      if (free <= EPS) continue
      const gap = free / 2
      const candidate: AxisMatch = {
        offset: g.at.end(left) + gap - start,
        rank: RANK_SPACING,
        lines: [
          { position: g.at.end(left) + gap / 2, rank: RANK_SPACING, rects: [left] },
          { position: g.at.start(right) - gap / 2, rank: RANK_SPACING, rects: [right] }
        ]
      }
      if (Math.abs(candidate.offset) > threshold) continue
      if (better(candidate, best)) best = candidate
    }
  }
  return best
}

function matchAxis(
  rect: Rect,
  others: readonly Rect[],
  axis: GuideAxis,
  op: AxisOp,
  settings: SnapSettings,
  threshold: number
): AxisMatch | null {
  if (op.mode === 'frozen') return null
  const role: Role = op.mode === 'move' ? 'start' : op.role

  let best: AxisMatch | null = null
  if (settings.smartGuides) {
    best = alignMatch(rect, others, axis, op.mode === 'move' ? ROLES : [op.role], threshold)
  }
  if (settings.equalSpacing && op.mode === 'move') {
    const spacing = spacingMatch(rect, others, axis, threshold)
    if (spacing !== null && better(spacing, best)) best = spacing
  }
  if (best !== null || !settings.grid) return best

  const moving = AXES[axis].at[role](rect)
  const offset = Math.round(moving / settings.gridSize) * settings.gridSize - moving
  if (Math.abs(offset) <= EPS || Math.abs(offset) > threshold) return null
  return { offset, rank: RANK_GRID, lines: [] }
}

function applyOffset(rect: Rect, axis: GuideAxis, op: AxisOp, offset: number): Rect {
  const g = AXES[axis]
  switch (op.mode) {
    case 'move':
      return g.place(rect, g.at.start(rect) + offset, g.size(rect))
    case 'edge':
      return op.role === 'start'
        ? g.place(rect, g.at.start(rect) + offset, g.size(rect) - offset)
        : g.place(rect, g.at.start(rect), g.size(rect) + offset)
    case 'frozen':
      throw new Error(`snapping: ось ${axis} зафиксирована, привязка на ${offset} невозможна`)
  }
}

function snap(
  rect: Rect,
  others: readonly Rect[],
  settings: SnapSettings,
  ops: Record<GuideAxis, AxisOp>
): SnapResult {
  if (!(settings.zoom > 0))
    throw new Error(`snapping: zoom должен быть положительным, получено ${settings.zoom}`)
  if (settings.grid && !(settings.gridSize > 0)) {
    throw new Error(`snapping: шаг сетки должен быть положительным, получено ${settings.gridSize}`)
  }
  const threshold = settings.thresholdPx / settings.zoom

  const matches: Record<GuideAxis, AxisMatch | null> = {
    x: matchAxis(rect, others, 'x', ops.x, settings, threshold),
    y: matchAxis(rect, others, 'y', ops.y, settings, threshold)
  }

  let out = rect
  const delta: Point = { x: 0, y: 0 }
  for (const axis of AXIS_ORDER) {
    const match = matches[axis]
    if (match === null) continue
    out = applyOffset(out, axis, ops[axis], match.offset)
    delta[axis] = match.offset
  }

  const guides: Guide[] = []
  for (const axis of AXIS_ORDER) {
    const match = matches[axis]
    if (match === null) continue
    const across = AXES[OTHER_AXIS[axis]]
    for (const line of match.lines) {
      let from = across.at.start(out)
      let to = across.at.end(out)
      for (const neighbour of line.rects) {
        from = Math.min(from, across.at.start(neighbour))
        to = Math.max(to, across.at.end(neighbour))
      }
      const kind = line.rank === RANK_CENTER ? 'center' : line.rank === RANK_SPACING ? 'spacing' : 'edge'
      guides.push({ axis, position: line.position, from, to, kind })
    }
  }

  return { rect: out, delta, guides }
}

/** Привязка при ПЕРЕМЕЩЕНИИ: двигаем весь rect целиком. */
export function snapMove(rect: Rect, others: readonly Rect[], settings: SnapSettings): SnapResult {
  return snap(rect, others, settings, { x: MOVE, y: MOVE })
}

/** Привязка при РЕСАЙЗЕ: двигаются только те края, что задаёт хэндл. */
export function snapResize(
  rect: Rect,
  handle: ResizeHandle,
  others: readonly Rect[],
  settings: SnapSettings
): SnapResult {
  return snap(rect, others, settings, HANDLE_OPS[handle])
}

/** Кандидаты на сравнение — соседи вокруг перетаскиваемого прямоугольника. */
export function snapCandidates(rect: Rect, all: readonly Rect[], radius: number): Rect[] {
  const area = expandRect(rect, radius)
  return all.filter((other) => rectsIntersect(area, other))
}
