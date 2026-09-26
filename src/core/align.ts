import { rectBottom, rectRight, unionRects } from './geometry'
import type { Rect } from './geometry'

export interface Placed {
  id: string
  rect: Rect
}

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'x' | 'y'
export type EqualizeMode = 'width' | 'height' | 'both'
export type PackMode = 'row' | 'column' | 'grid'

interface AxisSpec {
  pos: (r: Rect) => number
  size: (r: Rect) => number
  end: (r: Rect) => number
  move: (r: Rect, v: number) => Rect
}

const AXIS_X: AxisSpec = {
  pos: (r) => r.x,
  size: (r) => r.width,
  end: rectRight,
  move: (r, v) => ({ ...r, x: v })
}

const AXIS_Y: AxisSpec = {
  pos: (r) => r.y,
  size: (r) => r.height,
  end: rectBottom,
  move: (r, v) => ({ ...r, y: v })
}

const EDGES: Record<AlignEdge, { axis: AxisSpec; t: number }> = {
  left: { axis: AXIS_X, t: 0 },
  centerX: { axis: AXIS_X, t: 0.5 },
  right: { axis: AXIS_X, t: 1 },
  top: { axis: AXIS_Y, t: 0 },
  centerY: { axis: AXIS_Y, t: 0.5 },
  bottom: { axis: AXIS_Y, t: 1 }
}

/** Выравнивание по краю/центру объединяющего bounds. Возвращает только изменившиеся. */
export function alignRects(items: readonly Placed[], edge: AlignEdge): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const bounds = unionRects(items.map((item) => item.rect))
  if (!bounds) return out
  const { axis, t } = EDGES[edge]
  for (const item of items) {
    const target = axis.pos(bounds) + t * (axis.size(bounds) - axis.size(item.rect))
    if (target !== axis.pos(item.rect)) out.set(item.id, axis.move(item.rect, target))
  }
  return out
}

/** Равные ЗАЗОРЫ между соседями, крайние на месте. Возвращает только изменившиеся. */
export function distributeRects(items: readonly Placed[], axisKind: DistributeAxis): Map<string, Rect> {
  const out = new Map<string, Rect>()
  if (items.length < 3) return out
  const axis = axisKind === 'x' ? AXIS_X : AXIS_Y
  const sorted = [...items].sort((a, b) => axis.pos(a.rect) - axis.pos(b.rect))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) throw new Error('distributeRects: выборка потерялась при сортировке')
  const inner = sorted.slice(1, -1)
  const occupied = inner.reduce((sum, item) => sum + axis.size(item.rect), 0)
  const gap = (axis.pos(last.rect) - axis.end(first.rect) - occupied) / (sorted.length - 1)
  let cursor = axis.end(first.rect)
  for (const item of inner) {
    const target = cursor + gap
    if (target !== axis.pos(item.rect)) out.set(item.id, axis.move(item.rect, target))
    cursor = target + axis.size(item.rect)
  }
  return out
}

/** Уравнять размер по первому элементу входного массива. Возвращает только изменившиеся. */
export function equalizeRects(items: readonly Placed[], mode: EqualizeMode): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const [ref] = items
  if (!ref || items.length < 2) return out
  for (const item of items) {
    const width = mode === 'height' ? item.rect.width : ref.rect.width
    const height = mode === 'width' ? item.rect.height : ref.rect.height
    if (width !== item.rect.width || height !== item.rect.height) {
      out.set(item.id, { ...item.rect, width, height })
    }
  }
  return out
}

/** Упаковка от левого верхнего угла bounds с отступом gap. Возвращает только изменившиеся. */
export function packRects(
  items: readonly Placed[],
  mode: PackMode,
  gap: number,
  columns?: number
): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const bounds = unionRects(items.map((item) => item.rect))
  if (!bounds) return out
  const cols =
    mode === 'column' ? 1 : mode === 'row' ? items.length : (columns ?? Math.ceil(Math.sqrt(items.length)))
  if (!Number.isInteger(cols) || cols < 1) throw new Error(`packRects: columns=${String(columns)}`)
  const colWidths = new Array<number>(cols).fill(0)
  const rowHeights = new Array<number>(Math.ceil(items.length / cols)).fill(0)
  items.forEach((item, i) => {
    const c = i % cols
    const row = Math.floor(i / cols)
    colWidths[c] = Math.max(colWidths[c] ?? 0, item.rect.width)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, item.rect.height)
  })
  let y = bounds.y
  let i = 0
  for (const rowHeight of rowHeights) {
    let x = bounds.x
    for (const colWidth of colWidths) {
      const item = items[i]
      if (!item) break
      i += 1
      if (x !== item.rect.x || y !== item.rect.y) out.set(item.id, { ...item.rect, x, y })
      x += colWidth + gap
    }
    y += rowHeight + gap
  }
  return out
}
