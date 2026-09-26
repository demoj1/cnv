import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  cameraToTransform,
  clampZoom,
  fitRect,
  fitRects,
  panBy,
  screenToWorld,
  setZoomKeepingCenter,
  visibleWorldRect,
  worldRectToScreen,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Camera
} from '@core/camera'

const cam = (x: number, y: number, zoom: number): Camera => ({ x, y, zoom })

describe('преобразования координат', () => {
  it('worldToScreen обратно screenToWorld', () => {
    const c = cam(120, -40, 1.7)
    for (const p of [
      { x: 0, y: 0 },
      { x: -523.25, y: 811.5 },
      { x: 1e5, y: -1e5 }
    ]) {
      const back = screenToWorld(c, worldToScreen(c, p))
      expect(back.x).toBeCloseTo(p.x, 6)
      expect(back.y).toBeCloseTo(p.y, 6)
    }
  })

  it('при zoom 1 и нулевой камере координаты совпадают', () => {
    const c = cam(0, 0, 1)
    expect(worldToScreen(c, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
    expect(screenToWorld(c, { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('worldRectToScreen масштабирует размеры', () => {
    const r = worldRectToScreen(cam(5, 7, 2), { x: 10, y: 20, width: 30, height: 40 })
    expect(r).toEqual({ x: 25, y: 47, width: 60, height: 80 })
  })

  it('visibleWorldRect даёт мировую область вьюпорта', () => {
    const r = visibleWorldRect(cam(-100, -50, 2), { width: 800, height: 600 })
    expect(r).toEqual({ x: 50, y: 25, width: 400, height: 300 })
  })
})

describe('zoom', () => {
  it('точка под курсором остаётся на месте', () => {
    const anchor = { x: 640, y: 360 }
    let c = cam(13, -77, 0.83)
    const worldBefore = screenToWorld(c, anchor)
    for (const f of [1.25, 1.25, 0.8, 2, 0.5]) {
      c = zoomBy(c, anchor, f)
      const screenNow = worldToScreen(c, worldBefore)
      expect(screenNow.x).toBeCloseTo(anchor.x, 6)
      expect(screenNow.y).toBeCloseTo(anchor.y, 6)
    }
  })

  it('zoom зажат в допустимый диапазон', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(1000)).toBe(MAX_ZOOM)
    expect(zoomAt(cam(0, 0, 1), { x: 0, y: 0 }, 1e9).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(cam(0, 0, 1), { x: 0, y: 0 }, 1e-9).zoom).toBe(MIN_ZOOM)
  })

  it('упёршись в предел, камера не уезжает', () => {
    const anchor = { x: 100, y: 100 }
    const atMax = zoomAt(cam(0, 0, MAX_ZOOM), anchor, MAX_ZOOM * 4)
    expect(atMax.zoom).toBe(MAX_ZOOM)
    const world = screenToWorld(atMax, anchor)
    const before = screenToWorld(cam(0, 0, MAX_ZOOM), anchor)
    expect(world.x).toBeCloseTo(before.x, 6)
  })

  it('setZoomKeepingCenter держит центр вьюпорта', () => {
    const viewport = { width: 1000, height: 800 }
    const c = cam(37, -12, 0.6)
    const center = { x: viewport.width / 2, y: viewport.height / 2 }
    const worldCenter = screenToWorld(c, center)
    const next = setZoomKeepingCenter(c, viewport, 2.4)
    const screenNow = worldToScreen(next, worldCenter)
    expect(screenNow.x).toBeCloseTo(center.x, 6)
    expect(screenNow.y).toBeCloseTo(center.y, 6)
  })
})

describe('pan и fit', () => {
  it('panBy сдвигает в экранных пикселях', () => {
    expect(panBy(cam(10, 10, 3), 5, -5)).toEqual({ x: 15, y: 5, zoom: 3 })
  })

  it('fitRect вписывает прямоугольник и центрирует его', () => {
    const viewport = { width: 1000, height: 600 }
    const rect = { x: -200, y: 100, width: 400, height: 200 }
    const c = fitRect(rect, viewport, 50)
    const tl = worldToScreen(c, { x: rect.x, y: rect.y })
    const br = worldToScreen(c, { x: rect.x + rect.width, y: rect.y + rect.height })
    expect(br.x - tl.x).toBeLessThanOrEqual(viewport.width - 100 + 1e-6)
    expect(br.y - tl.y).toBeLessThanOrEqual(viewport.height - 100 + 1e-6)
    expect((tl.x + br.x) / 2).toBeCloseTo(viewport.width / 2, 6)
    expect((tl.y + br.y) / 2).toBeCloseTo(viewport.height / 2, 6)
  })

  it('fitRects складывает bounds, на пустом списке возвращает null', () => {
    const viewport = { width: 800, height: 800 }
    expect(fitRects([], viewport)).toBeNull()
    const c = fitRects(
      [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 900, y: 900, width: 100, height: 100 }
      ],
      viewport,
      0
    )
    expect(c).not.toBeNull()
    const center = worldToScreen(c as Camera, { x: 500, y: 500 })
    expect(center.x).toBeCloseTo(400, 6)
    expect(center.y).toBeCloseTo(400, 6)
  })

  it('вырожденный прямоугольник не ломает fit', () => {
    const c = fitRect({ x: 5, y: 5, width: 0, height: 0 }, { width: 100, height: 100 }, 0)
    expect(Number.isFinite(c.x)).toBe(true)
    expect(Number.isFinite(c.y)).toBe(true)
    expect(c.zoom).toBeLessThanOrEqual(MAX_ZOOM)
  })
})

describe('cameraToTransform', () => {
  it('формирует CSS-трансформ', () => {
    expect(cameraToTransform(cam(1.5, -2, 0.25))).toBe('translate(1.5px, -2px) scale(0.25)')
  })
})
