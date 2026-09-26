import { clamp, unionRects, type Point, type Rect, type Size } from './geometry'

export interface Camera {
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 4

export const IDENTITY_CAMERA: Camera = { x: 0, y: 0, zoom: 1 }

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom }
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y }
}

export function worldRectToScreen(cam: Camera, r: Rect): Rect {
  return {
    x: r.x * cam.zoom + cam.x,
    y: r.y * cam.zoom + cam.y,
    width: r.width * cam.zoom,
    height: r.height * cam.zoom
  }
}

export function visibleWorldRect(cam: Camera, viewport: Size): Rect {
  const tl = screenToWorld(cam, { x: 0, y: 0 })
  return {
    x: tl.x,
    y: tl.y,
    width: viewport.width / cam.zoom,
    height: viewport.height / cam.zoom
  }
}

export const clampZoom = (zoom: number): number => clamp(zoom, MIN_ZOOM, MAX_ZOOM)

export function zoomAt(cam: Camera, anchor: Point, nextZoom: number): Camera {
  const zoom = clampZoom(nextZoom)
  const world = screenToWorld(cam, anchor)
  return { zoom, x: anchor.x - world.x * zoom, y: anchor.y - world.y * zoom }
}

export function zoomBy(cam: Camera, anchor: Point, factor: number): Camera {
  return zoomAt(cam, anchor, cam.zoom * factor)
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x + dx, y: cam.y + dy }
}

export function fitRect(rect: Rect, viewport: Size, padding = 48): Camera {
  const w = Math.max(rect.width, 1)
  const h = Math.max(rect.height, 1)
  const availW = Math.max(viewport.width - padding * 2, 1)
  const availH = Math.max(viewport.height - padding * 2, 1)
  const zoom = clampZoom(Math.min(availW / w, availH / h))
  return {
    zoom,
    x: viewport.width / 2 - (rect.x + w / 2) * zoom,
    y: viewport.height / 2 - (rect.y + h / 2) * zoom
  }
}

export function fitRects(rects: readonly Rect[], viewport: Size, padding = 48): Camera | null {
  const bounds = unionRects(rects)
  return bounds ? fitRect(bounds, viewport, padding) : null
}

export function setZoomKeepingCenter(cam: Camera, viewport: Size, nextZoom: number): Camera {
  return zoomAt(cam, { x: viewport.width / 2, y: viewport.height / 2 }, nextZoom)
}

export function cameraToTransform(cam: Camera): string {
  return `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`
}
