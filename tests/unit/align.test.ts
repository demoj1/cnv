import { describe, expect, it } from 'vitest'
import { rectBottom, rectRight, type Rect } from '@core/geometry'
import { alignRects, distributeRects, equalizeRects, packRects, type Placed } from '@core/align'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })
const p = (id: string, x: number, y: number, width: number, height: number): Placed => ({
  id,
  rect: r(x, y, width, height)
})

const final = (items: readonly Placed[], out: Map<string, Rect>): Rect[] =>
  items.map((item) => out.get(item.id) ?? item.rect)

const gapsAlong = (rects: readonly Rect[], axis: 'x' | 'y'): number[] =>
  rects.slice(1).map((rect, i) => {
    const prev = rects[i]
    if (!prev) throw new Error('нет предыдущего прямоугольника')
    return axis === 'x' ? rect.x - rectRight(prev) : rect.y - rectBottom(prev)
  })

describe('выравнивание', () => {
  const items = [p('a', 0, 0, 100, 20), p('b', 50, 100, 40, 60), p('c', 200, 30, 10, 10)]

  it('left: все к минимальному x', () => {
    const out = alignRects(items, 'left')
    expect(out.get('b')).toEqual(r(0, 100, 40, 60))
    expect(out.get('c')).toEqual(r(0, 30, 10, 10))
    expect(out.has('a')).toBe(false)
  })

  it('right: правым краем к максимальному правому краю', () => {
    const out = alignRects(items, 'right')
    expect(out.get('a')).toEqual(r(110, 0, 100, 20))
    expect(out.get('b')).toEqual(r(170, 100, 40, 60))
    expect(out.has('c')).toBe(false)
  })

  it('centerX: центр bounds (105), а не среднее центров (108.33)', () => {
    const out = alignRects(items, 'centerX')
    expect(out.get('a')).toEqual(r(55, 0, 100, 20))
    expect(out.get('b')).toEqual(r(85, 100, 40, 60))
    expect(out.get('c')).toEqual(r(100, 30, 10, 10))
  })

  it('top: все к минимальному y', () => {
    const out = alignRects(items, 'top')
    expect(out.get('b')).toEqual(r(50, 0, 40, 60))
    expect(out.get('c')).toEqual(r(200, 0, 10, 10))
    expect(out.has('a')).toBe(false)
  })

  it('bottom: нижним краем к максимальному нижнему краю', () => {
    const out = alignRects(items, 'bottom')
    expect(out.get('a')).toEqual(r(0, 140, 100, 20))
    expect(out.get('c')).toEqual(r(200, 150, 10, 10))
    expect(out.has('b')).toBe(false)
  })

  it('centerY: центр bounds (80)', () => {
    const out = alignRects(items, 'centerY')
    expect(out.get('a')).toEqual(r(0, 70, 100, 20))
    expect(out.get('b')).toEqual(r(50, 50, 40, 60))
    expect(out.get('c')).toEqual(r(200, 75, 10, 10))
  })

  it('размеры не меняются ни в одном режиме', () => {
    for (const edge of ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as const) {
      const out = alignRects(items, edge)
      for (const item of items) {
        const moved = out.get(item.id)
        if (!moved) continue
        expect(moved.width).toBe(item.rect.width)
        expect(moved.height).toBe(item.rect.height)
      }
    }
  })

  it('уже выровненный набор даёт пустую Map', () => {
    const column = [p('a', 10, 0, 50, 10), p('b', 10, 40, 20, 10), p('c', 10, 80, 30, 10)]
    expect(alignRects(column, 'left').size).toBe(0)
  })

  it('пустой вход и один элемент', () => {
    expect(alignRects([], 'left').size).toBe(0)
    expect(alignRects([p('a', 3, 4, 5, 6)], 'centerX').size).toBe(0)
  })
})

describe('распределение', () => {
  it('по x: равные зазоры, крайние на месте', () => {
    const items = [p('a', 0, 0, 10, 10), p('b', 20, 0, 20, 10), p('c', 60, 0, 10, 10), p('d', 100, 0, 10, 10)]
    const out = distributeRects(items, 'x')
    expect(out.has('a')).toBe(false)
    expect(out.has('d')).toBe(false)
    expect(gapsAlong(final(items, out), 'x')).toEqual([20, 20, 20])
  })

  it('по x при разной ширине: равны ЗАЗОРЫ, а не шаги центров', () => {
    const items = [p('a', 0, 0, 10, 10), p('b', 50, 5, 30, 10), p('c', 100, 0, 20, 10)]
    const out = distributeRects(items, 'x')
    expect(out.get('b')).toEqual(r(40, 5, 30, 10))
    expect(out.size).toBe(1)
  })

  it('по y: равные зазоры, поперечная координата не тронута', () => {
    const items = [p('a', 0, 0, 10, 10), p('b', 5, 50, 10, 30), p('c', 0, 100, 10, 20)]
    const out = distributeRects(items, 'y')
    expect(out.get('b')).toEqual(r(5, 40, 10, 30))
    expect(out.has('a')).toBe(false)
    expect(out.has('c')).toBe(false)
    expect(gapsAlong(final(items, out), 'y')).toEqual([30, 30])
  })

  it('сортирует по координате, а не по порядку входа', () => {
    const items = [p('c', 100, 0, 20, 10), p('a', 0, 0, 10, 10), p('b', 50, 0, 30, 10)]
    expect(distributeRects(items, 'x').get('b')).toEqual(r(40, 0, 30, 10))
  })

  it('меньше трёх элементов — пустая Map', () => {
    expect(distributeRects([], 'x').size).toBe(0)
    expect(distributeRects([p('a', 0, 0, 10, 10)], 'x').size).toBe(0)
    expect(distributeRects([p('a', 0, 0, 10, 10), p('b', 100, 0, 10, 10)], 'x').size).toBe(0)
  })

  it('при нехватке места зазор отрицательный, в кучу не схлопываем', () => {
    const items = [p('a', 0, 0, 50, 10), p('b', 10, 0, 50, 10), p('c', 60, 0, 50, 10)]
    const out = distributeRects(items, 'x')
    expect(out.get('b')).toEqual(r(30, 0, 50, 10))
    const rects = final(items, out)
    const first = rects[0]
    const second = rects[1]
    const third = rects[2]
    if (!first || !second || !third) throw new Error('набор потерялся')
    expect(second.x - rectRight(first)).toBe(-20)
    expect(third.x - rectRight(second)).toBe(-20)
  })
})

describe('уравнивание размеров', () => {
  const items = [p('a', 0, 0, 100, 50), p('b', 10, 20, 30, 40), p('c', -5, -5, 100, 50)]

  it('width: ширина по первому, положение и высота на месте', () => {
    const out = equalizeRects(items, 'width')
    expect(out.get('b')).toEqual(r(10, 20, 100, 40))
    expect(out.size).toBe(1)
  })

  it('height: высота по первому', () => {
    const out = equalizeRects(items, 'height')
    expect(out.get('b')).toEqual(r(10, 20, 30, 50))
    expect(out.size).toBe(1)
  })

  it('both: оба размера по первому, эталон и совпадающие не в результате', () => {
    const out = equalizeRects(items, 'both')
    expect(out.get('b')).toEqual(r(10, 20, 100, 50))
    expect(out.has('a')).toBe(false)
    expect(out.has('c')).toBe(false)
  })

  it('меньше двух элементов — пустая Map', () => {
    expect(equalizeRects([], 'both').size).toBe(0)
    expect(equalizeRects([p('a', 0, 0, 10, 10)], 'both').size).toBe(0)
  })
})

describe('упаковка', () => {
  const items = [p('a', 0, 0, 50, 20), p('b', 200, 0, 30, 40), p('c', 0, 100, 10, 10)]

  it('row: одна строка слева направо', () => {
    const out = packRects(items, 'row', 10)
    expect(out.has('a')).toBe(false)
    expect(out.get('b')).toEqual(r(60, 0, 30, 40))
    expect(out.get('c')).toEqual(r(100, 0, 10, 10))
  })

  it('column: столбец сверху вниз', () => {
    const out = packRects(items, 'column', 10)
    expect(out.get('b')).toEqual(r(0, 30, 30, 40))
    expect(out.get('c')).toEqual(r(0, 80, 10, 10))
  })

  it('grid по умолчанию ceil(sqrt(n)) колонок, строки не наезжают', () => {
    const out = packRects(items, 'grid', 10)
    const [a, b, c] = final(items, out)
    if (!a || !b || !c) throw new Error('набор потерялся')
    expect(a).toEqual(r(0, 0, 50, 20))
    expect(b).toEqual(r(60, 0, 30, 40))
    expect(c).toEqual(r(0, 50, 10, 10))
    expect(c.y).toBeGreaterThanOrEqual(rectBottom(a))
    expect(c.y).toBeGreaterThanOrEqual(rectBottom(b))
  })

  it('grid с явным columns', () => {
    expect(packRects(items, 'grid', 10, 3).get('c')).toEqual(r(100, 0, 10, 10))
    expect(packRects(items, 'grid', 10, 1).get('c')).toEqual(r(0, 80, 10, 10))
  })

  it('ширина колонки — по самому широкому в колонке', () => {
    const wide = [p('a', 0, 0, 10, 10), p('b', 0, 0, 10, 10), p('c', 0, 0, 100, 10), p('d', 0, 0, 10, 10)]
    const out = packRects(wide, 'grid', 5, 2)
    expect(out.get('c')).toEqual(r(0, 15, 100, 10))
    expect(out.get('d')).toEqual(r(105, 15, 10, 10))
  })

  it('старт от левого верхнего угла bounds, а не от нуля', () => {
    const shifted = [p('a', 100, 50, 20, 20), p('b', 300, 50, 20, 20)]
    const out = packRects(shifted, 'row', 5)
    expect(out.has('a')).toBe(false)
    expect(out.get('b')).toEqual(r(125, 50, 20, 20))
  })

  it('порядок — как во входном массиве', () => {
    const reordered = [p('c', 0, 100, 10, 10), p('a', 0, 0, 50, 20), p('b', 200, 0, 30, 40)]
    expect(packRects(reordered, 'row', 10).get('c')).toEqual(r(0, 0, 10, 10))
  })

  it('пустой вход', () => {
    expect(packRects([], 'row', 10).size).toBe(0)
    expect(packRects([], 'grid', 10).size).toBe(0)
  })

  it('некорректный columns роняет сразу', () => {
    expect(() => packRects(items, 'grid', 10, 0)).toThrow()
    expect(() => packRects(items, 'grid', 10, 2.5)).toThrow()
  })
})

describe('вход не мутируется', () => {
  it('ни одна из функций не трогает исходные объекты', () => {
    const items = [p('a', 0, 0, 100, 20), p('b', 50, 100, 40, 60), p('c', 200, 30, 10, 10)]
    const before = structuredClone(items)
    alignRects(items, 'centerX')
    alignRects(items, 'bottom')
    distributeRects(items, 'x')
    distributeRects(items, 'y')
    equalizeRects(items, 'both')
    packRects(items, 'row', 10)
    packRects(items, 'grid', 10, 2)
    expect(items).toEqual(before)
  })
})
