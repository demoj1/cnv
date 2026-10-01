export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Point, Size {}

export const rectRight = (r: Rect): number => r.x + r.width
export const rectBottom = (r: Rect): number => r.y + r.height
export const rectCenterX = (r: Rect): number => r.x + r.width / 2
export const rectCenterY = (r: Rect): number => r.y + r.height / 2
export const rectCenter = (r: Rect): Point => ({ x: rectCenterX(r), y: rectCenterY(r) })

/** Поворот точки на `deg` вокруг центра (система экранная: y вниз, положительный угол по часовой). */
export function rotateAround(p: Point, center: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < rectRight(b) && rectRight(a) > b.x && a.y < rectBottom(b) && rectBottom(a) > b.y
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    rectRight(inner) <= rectRight(outer) &&
    rectBottom(inner) <= rectBottom(outer)
  )
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r)
}

export function expandRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 }
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (rectRight(r) > maxX) maxX = rectRight(r)
    if (rectBottom(r) > maxY) maxY = rectBottom(r)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  }
}

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

import type { NodeSide } from '@shared/canvas'

export function sideAnchor(r: Rect, side: NodeSide): Point {
  switch (side) {
    case 'top':
      return { x: rectCenterX(r), y: r.y }
    case 'right':
      return { x: rectRight(r), y: rectCenterY(r) }
    case 'bottom':
      return { x: rectCenterX(r), y: rectBottom(r) }
    case 'left':
      return { x: r.x, y: rectCenterY(r) }
  }
}

export function nearestSide(r: Rect, p: Point): NodeSide {
  const dx = (p.x - rectCenterX(r)) / (r.width || 1)
  const dy = (p.y - rectCenterY(r)) / (r.height || 1)
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'bottom' : 'top'
}
