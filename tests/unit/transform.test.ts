import { describe, expect, it } from 'vitest'
import { rectCenter, rotateAround, type Rect } from '@core/geometry'
import {
  RESIZE_HANDLES,
  aspectOf,
  boundingBoxWithPadding,
  handleCursor,
  handlePosition,
  marqueeSelect,
  moveRect,
  moveRects,
  resizeRect,
  resizeRotated
} from '@core/transform'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

const min = { width: 20, height: 20 }

describe('ресайз по хэндлам', () => {
  const box = r(100, 100, 200, 100)
  const delta = { x: 10, y: 20 }

  it.each([
    { handle: 'nw' as const, expected: r(110, 120, 190, 80) },
    { handle: 'n' as const, expected: r(100, 120, 200, 80) },
    { handle: 'ne' as const, expected: r(100, 120, 210, 80) },
    { handle: 'e' as const, expected: r(100, 100, 210, 100) },
    { handle: 'se' as const, expected: r(100, 100, 210, 120) },
    { handle: 's' as const, expected: r(100, 100, 200, 120) },
    { handle: 'sw' as const, expected: r(110, 100, 190, 120) },
    { handle: 'w' as const, expected: r(110, 100, 190, 100) }
  ])('хэндл $handle двигает только свои края', ({ handle, expected }) => {
    expect(resizeRect(box, handle, delta, { minSize: min })).toEqual(expected)
  })

  it('отрицательная дельта тянет в обратную сторону', () => {
    expect(resizeRect(box, 'se', { x: -50, y: -20 }, { minSize: min })).toEqual(r(100, 100, 150, 80))
    expect(resizeRect(box, 'nw', { x: -50, y: -20 }, { minSize: min })).toEqual(r(50, 80, 250, 120))
  })

  it.each(RESIZE_HANDLES.map((handle) => ({ handle })))(
    'нулевая дельта не меняет прямоугольник ($handle), в том числе дробный',
    ({ handle }) => {
      const fractional = r(0.1, 0.2, 100.3, 50.7)
      expect(resizeRect(fractional, handle, { x: 0, y: 0 }, { minSize: min })).toEqual(fractional)
    }
  )
})

describe('повёрнутый ресайз', () => {
  const box = r(0, 0, 200, 100)
  const corner = (rect: Rect, ax: number, ay: number, deg: number): { x: number; y: number } => {
    const c = rectCenter(rect)
    return rotateAround({ x: c.x + (ax * rect.width) / 2, y: c.y + (ay * rect.height) / 2 }, c, deg)
  }

  it('при нулевом угле совпадает с resizeRect', () => {
    for (const handle of RESIZE_HANDLES) {
      const d = { x: 17, y: -11 }
      expect(resizeRotated(box, handle, d, 0, { minSize: min })).toEqual(
        resizeRect(box, handle, d, { minSize: min })
      )
      expect(resizeRotated(box, handle, d, 360, { minSize: min })).toEqual(
        resizeRect(box, handle, d, { minSize: min })
      )
    }
  })

  it('при 90° противоположный угол неподвижен в мире', () => {
    const nwBefore = corner(box, -1, -1, 90) // (150, -50)
    const out = resizeRotated(box, 'se', { x: 10, y: 0 }, 90, { minSize: min })
    expect(out.width).toBeCloseTo(200, 6)
    expect(out.height).toBeCloseTo(90, 6)
    const nwAfter = corner(out, -1, -1, 90)
    expect(nwAfter.x).toBeCloseTo(nwBefore.x, 6)
    expect(nwAfter.y).toBeCloseTo(nwBefore.y, 6)
  })

  it('аспект держится и противоположный угол неподвижен', () => {
    const neBefore = corner(box, 1, -1, 30)
    const out = resizeRotated(box, 'sw', { x: -40, y: 20 }, 30, { minSize: min, aspectRatio: 2 })
    expect(out.width / out.height).toBeCloseTo(2, 6)
    const neAfter = corner(out, 1, -1, 30)
    expect(neAfter.x).toBeCloseTo(neBefore.x, 6)
    expect(neAfter.y).toBeCloseTo(neBefore.y, 6)
  })

  it('fromCenter держит центр неподвижным', () => {
    const c0 = rectCenter(box)
    const out = resizeRotated(box, 'se', { x: 30, y: 10 }, 48, { minSize: min, fromCenter: true })
    const c1 = rectCenter(out)
    expect(c1.x).toBeCloseTo(c0.x, 6)
    expect(c1.y).toBeCloseTo(c0.y, 6)
  })
})

describe('минимальный размер', () => {
  const box = r(100, 100, 200, 100)
  const minSize = { width: 50, height: 40 }

  it('правый край: левый остаётся на месте', () => {
    expect(resizeRect(box, 'e', { x: -500, y: 0 }, { minSize })).toEqual(r(100, 100, 50, 100))
  })

  it('левый край: правый остаётся на месте', () => {
    expect(resizeRect(box, 'w', { x: 500, y: 0 }, { minSize })).toEqual(r(250, 100, 50, 100))
  })

  it('нижний край: верхний остаётся на месте', () => {
    expect(resizeRect(box, 's', { x: 0, y: -500 }, { minSize })).toEqual(r(100, 100, 200, 40))
  })

  it('верхний край: нижний остаётся на месте', () => {
    expect(resizeRect(box, 'n', { x: 0, y: 500 }, { minSize })).toEqual(r(100, 160, 200, 40))
  })

  it('угол упирается по обеим осям сразу', () => {
    expect(resizeRect(box, 'nw', { x: 500, y: 500 }, { minSize })).toEqual(r(250, 160, 50, 40))
  })
})

describe('сохранение пропорций', () => {
  const box = r(0, 0, 100, 50)
  const opts = { minSize: { width: 10, height: 10 }, aspectRatio: 2 }

  it('угол: ведёт ось с большим изменением — X', () => {
    expect(resizeRect(box, 'se', { x: 50, y: 5 }, opts)).toEqual(r(0, 0, 150, 75))
  })

  it('угол: ведёт ось с большим изменением — Y', () => {
    expect(resizeRect(box, 'se', { x: 10, y: 40 }, opts)).toEqual(r(0, 0, 180, 90))
  })

  it('угол nw: противоположный угол не смещается', () => {
    const next = resizeRect(box, 'nw', { x: -50, y: -5 }, opts)
    expect(next).toEqual(r(-50, -25, 150, 75))
    expect(next.x + next.width).toBe(100)
    expect(next.y + next.height).toBe(50)
  })

  it('боковой n: ширина подгоняется, центр по X и нижний край на месте', () => {
    const next = resizeRect(box, 'n', { x: 0, y: -10 }, opts)
    expect(next).toEqual(r(-10, -10, 120, 60))
    expect(rectCenter(next).x).toBe(rectCenter(box).x)
  })

  it('боковой e: высота подгоняется, центр по Y и левый край на месте', () => {
    const next = resizeRect(box, 'e', { x: 20, y: 0 }, opts)
    expect(next).toEqual(r(0, -5, 120, 60))
    expect(rectCenter(next).y).toBe(rectCenter(box).y)
  })

  it('минимальный размер не ломает пропорцию: ширина растёт под минимум высоты', () => {
    const minSize = { width: 10, height: 30 }
    expect(resizeRect(box, 'se', { x: -500, y: 0 }, { minSize })).toEqual(r(0, 0, 10, 50))
    expect(resizeRect(box, 'se', { x: -500, y: 0 }, { minSize, aspectRatio: 2 })).toEqual(r(0, 0, 60, 30))
  })

  it('некорректная пропорция — сразу исключение', () => {
    expect(() => resizeRect(box, 'se', { x: 1, y: 1 }, { minSize: min, aspectRatio: 0 })).toThrow()
  })
})

describe('ресайз от центра', () => {
  const box = r(0, 0, 100, 50)

  it('центр не двигается, стороны растут вдвое', () => {
    const next = resizeRect(box, 'se', { x: 10, y: 10 }, { minSize: min, fromCenter: true })
    expect(next).toEqual(r(-10, -10, 120, 70))
    expect(rectCenter(next)).toEqual(rectCenter(box))
  })

  it('центр не двигается и при упоре в минимум', () => {
    const next = resizeRect(box, 'se', { x: -100, y: -100 }, { minSize: min, fromCenter: true })
    expect(next).toEqual(r(40, 15, 20, 20))
    expect(rectCenter(next)).toEqual(rectCenter(box))
  })

  it('работает с пропорцией', () => {
    const next = resizeRect(box, 'e', { x: 10, y: 0 }, { minSize: min, aspectRatio: 2, fromCenter: true })
    expect(next).toEqual(r(-10, -5, 120, 60))
    expect(rectCenter(next)).toEqual(rectCenter(box))
  })
})

describe('хэндлы: позиция и курсор', () => {
  const box = r(10, 20, 100, 50)

  it('восемь хэндлов без повторов', () => {
    expect(new Set(RESIZE_HANDLES).size).toBe(8)
  })

  it.each([
    { handle: 'nw' as const, point: { x: 10, y: 20 }, cursor: 'nwse-resize' },
    { handle: 'n' as const, point: { x: 60, y: 20 }, cursor: 'ns-resize' },
    { handle: 'ne' as const, point: { x: 110, y: 20 }, cursor: 'nesw-resize' },
    { handle: 'e' as const, point: { x: 110, y: 45 }, cursor: 'ew-resize' },
    { handle: 'se' as const, point: { x: 110, y: 70 }, cursor: 'nwse-resize' },
    { handle: 's' as const, point: { x: 60, y: 70 }, cursor: 'ns-resize' },
    { handle: 'sw' as const, point: { x: 10, y: 70 }, cursor: 'nesw-resize' },
    { handle: 'w' as const, point: { x: 10, y: 45 }, cursor: 'ew-resize' }
  ])('$handle', ({ handle, point, cursor }) => {
    expect(handlePosition(box, handle)).toEqual(point)
    expect(handleCursor(handle)).toBe(cursor)
  })
})

describe('перемещение', () => {
  it('moveRect сдвигает и сохраняет размер', () => {
    expect(moveRect(r(10, 10, 5, 5), { x: -3, y: 7 })).toEqual(r(7, 17, 5, 5))
  })

  it('moveRects не мутирует вход и сохраняет чужие поля', () => {
    type Item = Rect & { label: string }
    const a: Item = { ...r(0, 0, 10, 10), label: 'a' }
    const b: Item = { ...r(50, 50, 10, 10), label: 'b' }
    const items = new Map<string, Item>([
      ['a', a],
      ['b', b]
    ])

    const moved = moveRects(items, { x: 5, y: -5 })

    expect(moved.get('a')).toEqual({ x: 5, y: -5, width: 10, height: 10, label: 'a' })
    expect(moved.get('b')).toEqual({ x: 55, y: 45, width: 10, height: 10, label: 'b' })
    expect(a).toEqual({ x: 0, y: 0, width: 10, height: 10, label: 'a' })
    expect(items.get('a')).toBe(a)
    expect(moved).not.toBe(items)
  })
})

describe('marquee-выделение', () => {
  const box = r(0, 0, 100, 100)
  const items = [
    { id: 'outside', rect: r(200, 200, 10, 10) },
    { id: 'half', rect: r(50, 50, 100, 100) },
    { id: 'inside', rect: r(10, 10, 10, 10) },
    { id: 'exact', rect: r(0, 0, 100, 100) },
    { id: 'touching', rect: r(100, 0, 10, 10) }
  ]

  it('пересечение: половинки попадают, касание краями — нет', () => {
    expect(marqueeSelect(items, box, false)).toEqual(['half', 'inside', 'exact'])
  })

  it('containedOnly: только целиком внутри, совпадение границ считается попаданием', () => {
    expect(marqueeSelect(items, box, true)).toEqual(['inside', 'exact'])
  })

  it('порядок результата — порядок входа', () => {
    const reversed = [...items].reverse()
    expect(marqueeSelect(reversed, box, false)).toEqual(['exact', 'inside', 'half'])
  })

  it('пустой ввод', () => {
    expect(marqueeSelect([], box, false)).toEqual([])
  })
})

describe('рамка вокруг набора', () => {
  it('пустой список — null', () => {
    expect(boundingBoxWithPadding([], 10)).toBeNull()
  })

  it('несколько прямоугольников с отступом', () => {
    expect(boundingBoxWithPadding([r(0, 0, 10, 10), r(20, -5, 10, 10)], 5)).toEqual(r(-5, -10, 40, 25))
  })

  it('один прямоугольник и нулевой отступ', () => {
    expect(boundingBoxWithPadding([r(3, 4, 10, 20)], 0)).toEqual(r(3, 4, 10, 20))
  })
})

describe('пропорция прямоугольника', () => {
  it('обычный прямоугольник', () => {
    expect(aspectOf(r(0, 0, 100, 50))).toBe(2)
    expect(aspectOf(r(0, 0, 50, 100))).toBe(0.5)
  })

  it('вырожденный прямоугольник даёт нейтральную единицу, а не Infinity/NaN', () => {
    expect(aspectOf(r(0, 0, 100, 0))).toBe(1)
    expect(aspectOf(r(0, 0, 0, 0))).toBe(1)
  })

  it('ресайз вырожденного прямоугольника даёт конечный результат', () => {
    const degenerate = r(0, 0, 100, 0)
    const next = resizeRect(
      degenerate,
      'se',
      { x: 10, y: 10 },
      { minSize: min, aspectRatio: aspectOf(degenerate) }
    )
    expect(next).toEqual(r(0, 0, 110, 110))
  })
})

describe('инвариант минимального размера', () => {
  it.each(RESIZE_HANDLES.map((handle) => ({ handle })))(
    '$handle: результат не меньше minSize ни по одной оси',
    ({ handle }) => {
      const minSize = { width: 30, height: 15 }
      for (const dx of [-1000, -13, 0, 7, 1000]) {
        for (const dy of [-1000, -13, 0, 7, 1000]) {
          const free = resizeRect(r(0, 0, 100, 50), handle, { x: dx, y: dy }, { minSize })
          expect(free.width).toBeGreaterThanOrEqual(minSize.width)
          expect(free.height).toBeGreaterThanOrEqual(minSize.height)

          const kept = resizeRect(r(0, 0, 100, 50), handle, { x: dx, y: dy }, { minSize, aspectRatio: 2 })
          expect(kept.width).toBeGreaterThanOrEqual(minSize.width)
          expect(kept.height).toBeGreaterThanOrEqual(minSize.height)
          expect(kept.width / kept.height).toBeCloseTo(2)
        }
      }
    }
  )
})
