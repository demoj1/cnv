import { describe, expect, it } from 'vitest'
import {
  clamp,
  expandRect,
  nearestSide,
  normalizeRect,
  pointInRect,
  rectBottom,
  rectCenter,
  rectContains,
  rectRight,
  rectsIntersect,
  sideAnchor,
  unionRects,
  type Rect
} from '@core/geometry'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

describe('прямоугольники', () => {
  it('right/bottom/center', () => {
    const a = r(10, 20, 30, 40)
    expect(rectRight(a)).toBe(40)
    expect(rectBottom(a)).toBe(60)
    expect(rectCenter(a)).toEqual({ x: 25, y: 40 })
  })

  it('пересечение: касание краями пересечением не считается', () => {
    expect(rectsIntersect(r(0, 0, 10, 10), r(5, 5, 10, 10))).toBe(true)
    expect(rectsIntersect(r(0, 0, 10, 10), r(10, 0, 10, 10))).toBe(false)
    expect(rectsIntersect(r(0, 0, 10, 10), r(11, 0, 10, 10))).toBe(false)
  })

  it('вложенность, включая совпадающие границы', () => {
    expect(rectContains(r(0, 0, 100, 100), r(10, 10, 10, 10))).toBe(true)
    expect(rectContains(r(0, 0, 100, 100), r(0, 0, 100, 100))).toBe(true)
    expect(rectContains(r(0, 0, 100, 100), r(50, 50, 60, 10))).toBe(false)
  })

  it('точка в прямоугольнике', () => {
    expect(pointInRect({ x: 5, y: 5 }, r(0, 0, 10, 10))).toBe(true)
    expect(pointInRect({ x: 10, y: 10 }, r(0, 0, 10, 10))).toBe(true)
    expect(pointInRect({ x: 10.1, y: 5 }, r(0, 0, 10, 10))).toBe(false)
  })

  it('expandRect растит во все стороны', () => {
    expect(expandRect(r(10, 10, 10, 10), 5)).toEqual(r(5, 5, 20, 20))
  })

  it('unionRects', () => {
    expect(unionRects([])).toBeNull()
    expect(unionRects([r(0, 0, 10, 10), r(20, -5, 10, 10)])).toEqual(r(0, -5, 30, 15))
  })

  it('normalizeRect работает при любом порядке точек', () => {
    expect(normalizeRect({ x: 10, y: 10 }, { x: 0, y: 4 })).toEqual(r(0, 4, 10, 6))
    expect(normalizeRect({ x: 0, y: 4 }, { x: 10, y: 10 })).toEqual(r(0, 4, 10, 6))
  })

  it('clamp', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

describe('стороны ноды', () => {
  const box = r(0, 0, 100, 50)

  it('якоря сторон', () => {
    expect(sideAnchor(box, 'top')).toEqual({ x: 50, y: 0 })
    expect(sideAnchor(box, 'right')).toEqual({ x: 100, y: 25 })
    expect(sideAnchor(box, 'bottom')).toEqual({ x: 50, y: 50 })
    expect(sideAnchor(box, 'left')).toEqual({ x: 0, y: 25 })
  })

  it('ближайшая сторона считается в долях размера, а не в пикселях', () => {
    expect(nearestSide(box, { x: 200, y: 25 })).toBe('right')
    expect(nearestSide(box, { x: -200, y: 25 })).toBe('left')
    expect(nearestSide(box, { x: 50, y: -100 })).toBe('top')
    expect(nearestSide(box, { x: 50, y: 200 })).toBe('bottom')
    // узкий и высокий: сдвиг по X в 30 px важнее сдвига по Y в 60 px
    expect(nearestSide(r(0, 0, 40, 400), { x: 50, y: 260 })).toBe('right')
  })
})
