import { expandRect, rectContains, rectsIntersect, unionRects } from './geometry'
import type { Point, Rect, Size } from './geometry'

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

type Axis = -1 | 0 | 1

const HANDLE_AXES: Record<ResizeHandle, { x: Axis; y: Axis }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 }
}

export interface ResizeOptions {
  minSize: Size
  /** Отношение ширины к высоте, которое надо сохранить. null — свободный ресайз. */
  aspectRatio?: number | null
  /** Тянуть симметрично от центра (Alt в редакторах). */
  fromCenter?: boolean
}

/** Пересчитывает прямоугольник при перетаскивании одного из 8 хэндлов. `delta` — сдвиг курсора в мировых координатах. */
export function resizeRect(rect: Rect, handle: ResizeHandle, delta: Point, options: ResizeOptions): Rect {
  const axes = HANDLE_AXES[handle]
  const ratio = options.aspectRatio ?? null
  if (ratio !== null && !(ratio > 0 && Number.isFinite(ratio))) {
    throw new Error(`resizeRect: некорректная пропорция ${ratio}`)
  }

  const fromCenter = options.fromCenter === true
  const grow = fromCenter ? 2 : 1
  let width = rect.width + axes.x * delta.x * grow
  let height = rect.height + axes.y * delta.y * grow

  if (ratio !== null) {
    const widthLeads =
      axes.x === 0 ? false : axes.y === 0 || Math.abs(width - rect.width) >= Math.abs(height - rect.height)
    if (widthLeads) height = width / ratio
    else width = height * ratio
    width = Math.max(width, options.minSize.width, options.minSize.height * ratio)
    height = width / ratio
  } else {
    width = Math.max(width, options.minSize.width)
    height = Math.max(height, options.minSize.height)
  }

  const shiftX = fromCenter || axes.x === 0 ? 0.5 : axes.x < 0 ? 1 : 0
  const shiftY = fromCenter || axes.y === 0 ? 0.5 : axes.y < 0 ? 1 : 0
  return {
    x: rect.x + (rect.width - width) * shiftX,
    y: rect.y + (rect.height - height) * shiftY,
    width,
    height
  }
}

/** Точка хэндла в тех же координатах, что и `rect` — для отрисовки оверлея. */
export function handlePosition(rect: Rect, handle: ResizeHandle): Point {
  const axes = HANDLE_AXES[handle]
  return {
    x: rect.x + (rect.width * (axes.x + 1)) / 2,
    y: rect.y + (rect.height * (axes.y + 1)) / 2
  }
}

/** CSS-курсор для хэндла. */
export function handleCursor(handle: ResizeHandle): string {
  const axes = HANDLE_AXES[handle]
  if (axes.x === 0) return 'ns-resize'
  if (axes.y === 0) return 'ew-resize'
  return axes.x === axes.y ? 'nwse-resize' : 'nesw-resize'
}

export function moveRect(rect: Rect, delta: Point): Rect {
  return { ...rect, x: rect.x + delta.x, y: rect.y + delta.y }
}

/** Сдвигает набор прямоугольников по id. */
export function moveRects<T extends Rect>(items: ReadonlyMap<string, T>, delta: Point): Map<string, T> {
  const moved = new Map<string, T>()
  for (const [id, item] of items) {
    moved.set(id, { ...item, x: item.x + delta.x, y: item.y + delta.y })
  }
  return moved
}

/** Marquee: `containedOnly` — только целиком попавшие, иначе все пересекающиеся. */
export function marqueeSelect(
  items: readonly { id: string; rect: Rect }[],
  box: Rect,
  containedOnly: boolean
): string[] {
  return items
    .filter((item) => (containedOnly ? rectContains(box, item.rect) : rectsIntersect(box, item.rect)))
    .map((item) => item.id)
}

/** Прямоугольник вокруг набора с отступом — для команды «сгруппировать выделенное». */
export function boundingBoxWithPadding(rects: readonly Rect[], padding: number): Rect | null {
  const box = unionRects(rects)
  return box === null ? null : expandRect(box, padding)
}

/** Пропорция, которую надо держать при ресайзе (ширина / высота). */
export function aspectOf(rect: Rect): number {
  if (rect.width <= 0 || rect.height <= 0) return 1
  return rect.width / rect.height
}
