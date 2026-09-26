import {
  IDENTITY_CAMERA,
  clampZoom,
  fitRect,
  fitRects,
  panBy,
  setZoomKeepingCenter,
  visibleWorldRect,
  zoomAt,
  zoomBy,
  type Camera
} from './camera'
import type { Point, Rect, Size } from './geometry'
import type { Unsubscribe } from './observable'

type Listener = (cam: Camera) => void

/**
 * Камера живёт вне React: подписчики `raw` получают значение синхронно (прямая запись
 * в style.transform), подписчики `frame` — не чаще раза за кадр (culling, LOD, HUD).
 */
export class CameraController {
  private cam: Camera = IDENTITY_CAMERA
  private viewport: Size = { width: 0, height: 0 }
  private raw = new Set<Listener>()
  private framed = new Set<Listener>()
  private frameHandle = 0
  private interacting = false
  private interactionListeners = new Set<(active: boolean) => void>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  get value(): Camera {
    return this.cam
  }

  get viewportSize(): Size {
    return this.viewport
  }

  get isInteracting(): boolean {
    return this.interacting
  }

  setViewport(size: Size): void {
    this.viewport = size
  }

  set(next: Camera): void {
    const cam = { ...next, zoom: clampZoom(next.zoom) }
    if (cam.x === this.cam.x && cam.y === this.cam.y && cam.zoom === this.cam.zoom) return
    this.cam = cam
    for (const l of [...this.raw]) l(cam)
    this.scheduleFrame()
  }

  pan(dx: number, dy: number): void {
    this.set(panBy(this.cam, dx, dy))
  }

  zoomBy(anchor: Point, factor: number): void {
    this.set(zoomBy(this.cam, anchor, factor))
  }

  zoomTo(anchor: Point, zoom: number): void {
    this.set(zoomAt(this.cam, anchor, zoom))
  }

  zoomToCenter(zoom: number): void {
    this.set(setZoomKeepingCenter(this.cam, this.viewport, zoom))
  }

  fit(rect: Rect, padding?: number): void {
    this.set(fitRect(rect, this.viewport, padding))
  }

  fitAll(rects: readonly Rect[], padding?: number): void {
    const next = fitRects(rects, this.viewport, padding)
    if (next) this.set(next)
  }

  visibleRect(padding = 0): Rect {
    const r = visibleWorldRect(this.cam, this.viewport)
    if (!padding) return r
    const pad = padding / this.cam.zoom
    return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
  }

  /** Держит флаг «идёт pan/zoom» и гасит его через idleMs после последнего движения. */
  markInteraction(idleMs = 150): void {
    if (!this.interacting) {
      this.interacting = true
      for (const l of [...this.interactionListeners]) l(true)
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.interacting = false
      this.idleTimer = null
      for (const l of [...this.interactionListeners]) l(false)
    }, idleMs)
  }

  subscribeRaw(listener: Listener): Unsubscribe {
    this.raw.add(listener)
    return () => this.raw.delete(listener)
  }

  subscribeFrame(listener: Listener): Unsubscribe {
    this.framed.add(listener)
    return () => this.framed.delete(listener)
  }

  subscribeInteraction(listener: (active: boolean) => void): Unsubscribe {
    this.interactionListeners.add(listener)
    return () => this.interactionListeners.delete(listener)
  }

  private scheduleFrame(): void {
    if (this.frameHandle) return
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = 0
      for (const l of [...this.framed]) l(this.cam)
    })
  }

  dispose(): void {
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.raw.clear()
    this.framed.clear()
    this.interactionListeners.clear()
  }
}
