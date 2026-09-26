import { describe, expect, it } from 'vitest'
import { rectBottom, rectRight, type Rect } from '@core/geometry'
import { RESIZE_HANDLES } from '@core/transform'
import { snapCandidates, snapMove, snapResize, type SnapSettings } from '@core/snapping'

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

const opts = (over: Partial<SnapSettings> = {}): SnapSettings => ({
  grid: false,
  gridSize: 10,
  smartGuides: true,
  equalSpacing: false,
  thresholdPx: 8,
  zoom: 1,
  ...over
})

describe('смарт-направляющие: края', () => {
  it('левый край к левому краю соседа', () => {
    const box = r(103, 200, 50, 50)
    const result = snapMove(box, [r(100, 0, 40, 40)], opts())

    expect(result.rect).toEqual(r(100, 200, 50, 50))
    expect(result.delta).toEqual({ x: -3, y: 0 })
    expect(result.guides).toEqual([{ axis: 'x', position: 100, from: 0, to: 250, kind: 'edge' }])
  })

  it('правый край к правому краю соседа', () => {
    const result = snapMove(r(173, 300, 30, 30), [r(100, 0, 100, 50)], opts())

    expect(result.rect).toEqual(r(170, 300, 30, 30))
    expect(rectRight(result.rect)).toBe(200)
    expect(result.guides).toEqual([{ axis: 'x', position: 200, from: 0, to: 330, kind: 'edge' }])
  })

  it('левый край к правому краю соседа — встают встык', () => {
    const neighbour = r(0, 0, 100, 100)
    const result = snapMove(r(104, 300, 50, 50), [neighbour], opts())

    expect(result.rect.x).toBe(rectRight(neighbour))
    expect(result.guides).toEqual([{ axis: 'x', position: 100, from: 0, to: 350, kind: 'edge' }])
  })

  it('верхний край к нижнему краю соседа', () => {
    const result = snapMove(r(300, 104, 50, 50), [r(0, 0, 100, 100)], opts())

    expect(result.rect).toEqual(r(300, 100, 50, 50))
    expect(result.guides).toEqual([{ axis: 'y', position: 100, from: 0, to: 350, kind: 'edge' }])
  })

  it('уже выровненный край даёт направляющую и нулевое смещение', () => {
    const result = snapMove(r(100, 200, 50, 50), [r(100, 0, 40, 40)], opts())

    expect(result.rect).toEqual(r(100, 200, 50, 50))
    expect(result.delta).toEqual({ x: 0, y: 0 })
    expect(result.guides).toEqual([{ axis: 'x', position: 100, from: 0, to: 250, kind: 'edge' }])
  })
})

describe('смарт-направляющие: центры', () => {
  it('центр к центру по обеим осям', () => {
    const result = snapMove(r(45, 45, 12, 12), [r(0, 0, 100, 100)], opts())

    expect(result.rect).toEqual(r(44, 44, 12, 12))
    expect(result.delta).toEqual({ x: -1, y: -1 })
    expect(result.guides).toEqual([
      { axis: 'x', position: 50, from: 0, to: 100, kind: 'center' },
      { axis: 'y', position: 50, from: 0, to: 100, kind: 'center' }
    ])
  })
})

describe('приоритет совпадений на одинаковом расстоянии', () => {
  const dragged = r(110, 300, 100, 60)
  const edgeNeighbour = r(0, 0, 100, 10)
  const centerNeighbour = r(150, 0, 40, 10)

  it('край к краю побеждает центр к центру', () => {
    const result = snapMove(dragged, [edgeNeighbour, centerNeighbour], opts({ thresholdPx: 10 }))

    expect(result.rect.x).toBe(100)
    expect(result.guides.map((g) => [g.position, g.kind])).toEqual([
      [100, 'edge'],
      [150, 'edge']
    ])
  })

  it('центр к центру побеждает край к центру', () => {
    const result = snapMove(dragged, [centerNeighbour], opts({ thresholdPx: 10 }))

    expect(result.rect.x).toBe(120)
    expect(result.guides).toEqual([{ axis: 'x', position: 170, from: 0, to: 360, kind: 'center' }])
  })
})

describe('порог срабатывания', () => {
  const neighbour = r(0, 0, 100, 100)

  it('чуть меньше порога — привязка есть', () => {
    expect(snapMove(r(107, 300, 20, 20), [neighbour], opts()).rect.x).toBe(100)
  })

  it('ровно порог — привязка есть', () => {
    expect(snapMove(r(108, 300, 20, 20), [neighbour], opts()).rect.x).toBe(100)
  })

  it('чуть больше порога — привязки нет', () => {
    const box = r(109, 300, 20, 20)
    const result = snapMove(box, [neighbour], opts())

    expect(result.rect).toBe(box)
    expect(result.delta).toEqual({ x: 0, y: 0 })
    expect(result.guides).toEqual([])
  })

  it('порог меряется в экранных пикселях: zoom 1 привязывает, zoom 2 — нет', () => {
    const box = r(106, 300, 20, 20)

    expect(snapMove(box, [neighbour], opts({ zoom: 1 })).rect.x).toBe(100)

    const zoomed = snapMove(box, [neighbour], opts({ zoom: 2 }))
    expect(zoomed.rect).toBe(box)
    expect(zoomed.guides).toEqual([])
  })

  it('нулевой и отрицательный zoom — сразу исключение', () => {
    expect(() => snapMove(r(0, 0, 10, 10), [], opts({ zoom: 0 }))).toThrow()
    expect(() => snapMove(r(0, 0, 10, 10), [], opts({ zoom: -1 }))).toThrow()
  })
})

describe('привязка к сетке', () => {
  const grid = opts({ grid: true, gridSize: 20, smartGuides: false })

  it('к ближайшему узлу по обеим осям, без направляющих', () => {
    const result = snapMove(r(103, 57, 30, 30), [], grid)

    expect(result.rect).toEqual(r(100, 60, 30, 30))
    expect(result.delta).toEqual({ x: -3, y: 3 })
    expect(result.guides).toEqual([])
  })

  it('узел дальше порога — привязки нет', () => {
    const box = r(110, 57, 30, 30)
    expect(snapMove(box, [], opts({ grid: true, gridSize: 100, smartGuides: false })).rect).toBe(box)
  })

  it('прямоугольник уже на сетке — ничего не двигается', () => {
    const box = r(100, 60, 30, 30)
    const result = snapMove(box, [], grid)

    expect(result.rect).toBe(box)
    expect(result.delta).toEqual({ x: 0, y: 0 })
  })

  it('смарт-направляющая побеждает сетку, даже если узел ближе', () => {
    const result = snapMove(r(103, 500, 30, 30), [r(0, 0, 97, 10)], opts({ grid: true, gridSize: 20 }))

    expect(result.rect).toEqual(r(97, 500, 30, 30))
    expect(result.guides).toEqual([{ axis: 'x', position: 97, from: 0, to: 530, kind: 'edge' }])
  })

  it('оси независимы: по X смарт-направляющая, по Y сетка', () => {
    const result = snapMove(r(103, 503, 30, 30), [r(0, 0, 97, 10)], opts({ grid: true, gridSize: 20 }))

    expect(result.rect).toEqual(r(97, 500, 30, 30))
    expect(result.delta).toEqual({ x: -6, y: -3 })
    expect(result.guides).toEqual([{ axis: 'x', position: 97, from: 0, to: 530, kind: 'edge' }])
  })

  it('некорректный шаг сетки при включённой сетке — сразу исключение', () => {
    expect(() => snapMove(r(1, 1, 10, 10), [], opts({ grid: true, gridSize: 0 }))).toThrow()
    expect(() => snapMove(r(1, 1, 10, 10), [], opts({ grid: false, gridSize: 0 }))).not.toThrow()
  })
})

describe('выключённые настройки', () => {
  it('всё выключено — прямоугольник тот же, ни смещения, ни направляющих', () => {
    const box = r(103, 57, 30, 30)
    const result = snapMove(box, [r(100, 50, 10, 10)], opts({ smartGuides: false, grid: false }))

    expect(result.rect).toBe(box)
    expect(result.delta).toEqual({ x: 0, y: 0 })
    expect(result.guides).toEqual([])
  })
})

describe('равные отступы', () => {
  const left = r(0, 0, 100, 100)
  const right = r(400, 0, 100, 100)
  const dragged = r(204, 10, 100, 30)

  it('средний прямоугольник встаёт в равный промежуток', () => {
    const result = snapMove(dragged, [left, right], opts({ equalSpacing: true }))

    expect(result.rect).toEqual(r(200, 10, 100, 30))
    expect(result.delta).toEqual({ x: -4, y: 0 })
    expect(result.rect.x - rectRight(left)).toBe(right.x - rectRight(result.rect))
  })

  it('отдаёт по направляющей на каждый промежуток с kind spacing', () => {
    const result = snapMove(dragged, [left, right], opts({ equalSpacing: true }))

    expect(result.guides).toEqual([
      { axis: 'x', position: 150, from: 0, to: 100, kind: 'spacing' },
      { axis: 'x', position: 350, from: 0, to: 100, kind: 'spacing' }
    ])
  })

  it('работает и по вертикали', () => {
    const result = snapMove(
      r(10, 204, 30, 100),
      [r(0, 0, 100, 100), r(0, 400, 100, 100)],
      opts({ equalSpacing: true })
    )

    expect(result.rect).toEqual(r(10, 200, 30, 100))
    expect(result.guides).toEqual([
      { axis: 'y', position: 150, from: 0, to: 100, kind: 'spacing' },
      { axis: 'y', position: 350, from: 0, to: 100, kind: 'spacing' }
    ])
  })

  it('equalSpacing выключен — промежутки не учитываются', () => {
    const result = snapMove(dragged, [left, right], opts({ equalSpacing: false }))

    expect(result.rect).toBe(dragged)
    expect(result.guides).toEqual([])
  })

  it('сосед не в одном ряду — промежуток не считается', () => {
    const offRow = r(400, 900, 100, 100)
    const result = snapMove(dragged, [left, offRow], opts({ equalSpacing: true }))

    expect(result.rect).toBe(dragged)
    expect(result.guides).toEqual([])
  })
})

describe('протяжённость направляющей', () => {
  it('from/to покрывают перетаскиваемый и всех участников совпадения', () => {
    const above = r(100, 0, 40, 10)
    const below = r(100, 500, 40, 10)
    const result = snapMove(r(103, 200, 50, 50), [above, below], opts())

    expect(result.guides).toEqual([{ axis: 'x', position: 100, from: 0, to: 510, kind: 'edge' }])
  })
})

describe('привязка при ресайзе', () => {
  const box = r(104, 104, 200, 200)
  const others = [r(0, 0, 100, 100), r(300, 300, 100, 100)]

  it.each([
    { handle: 'nw' as const, expected: r(100, 100, 204, 204), delta: { x: -4, y: -4 } },
    { handle: 'n' as const, expected: r(104, 100, 200, 204), delta: { x: 0, y: -4 } },
    { handle: 'ne' as const, expected: r(104, 100, 196, 204), delta: { x: -4, y: -4 } },
    { handle: 'e' as const, expected: r(104, 104, 196, 200), delta: { x: -4, y: 0 } },
    { handle: 'se' as const, expected: r(104, 104, 196, 196), delta: { x: -4, y: -4 } },
    { handle: 's' as const, expected: r(104, 104, 200, 196), delta: { x: 0, y: -4 } },
    { handle: 'sw' as const, expected: r(100, 104, 204, 196), delta: { x: -4, y: -4 } },
    { handle: 'w' as const, expected: r(100, 104, 204, 200), delta: { x: -4, y: 0 } }
  ])('хэндл $handle привязывает только свои края', ({ handle, expected, delta }) => {
    const result = snapResize(box, handle, others, opts())

    expect(result.rect).toEqual(expected)
    expect(result.delta).toEqual(delta)
  })

  it.each(RESIZE_HANDLES.map((handle) => ({ handle })))(
    '$handle: неподвижные края не сдвинулись ни на пиксель',
    ({ handle }) => {
      const out = snapResize(box, handle, others, opts()).rect

      if (!handle.includes('w')) expect(out.x).toBe(box.x)
      if (!handle.includes('e')) expect(rectRight(out)).toBe(rectRight(box))
      if (!handle.includes('n')) expect(out.y).toBe(box.y)
      if (!handle.includes('s')) expect(rectBottom(out)).toBe(rectBottom(box))
    }
  )

  it('зафиксированная хэндлом ось не привязывается даже к сетке', () => {
    const result = snapResize(box, 'n', others, opts({ grid: true, gridSize: 20 }))

    expect(result.rect).toEqual(r(104, 100, 200, 204))
    expect(result.delta).toEqual({ x: 0, y: -4 })
  })

  it('подвижный край ловит сетку, если соседей рядом нет', () => {
    const result = snapResize(r(104, 104, 200, 200), 'e', [], opts({ grid: true, gridSize: 100 }))

    expect(result.rect).toEqual(r(104, 104, 196, 200))
  })

  it('центр не участвует в ресайзе — привязываются только края', () => {
    const square = r(0, 0, 100, 100)
    const result = snapResize(square, 'e', [r(54, 0, 200, 100)], opts())

    expect(result.rect).toBe(square)
    expect(result.guides).toEqual([])
  })

  it('ничего не совпало — тот же прямоугольник', () => {
    const box2 = r(1000, 1000, 50, 50)
    const result = snapResize(box2, 'se', others, opts())

    expect(result.rect).toBe(box2)
    expect(result.delta).toEqual({ x: 0, y: 0 })
    expect(result.guides).toEqual([])
  })
})

describe('кандидаты вокруг прямоугольника', () => {
  const box = r(0, 0, 100, 100)
  const near1 = r(120, 20, 10, 10)
  const near2 = r(-60, -60, 20, 20)
  const touching = r(150, 0, 10, 10)
  const far = r(300, 0, 10, 10)

  it('далёкие соседи не попадают, порядок входа сохраняется', () => {
    expect(snapCandidates(box, [far, near1, touching, near2], 50)).toEqual([near1, near2])
  })

  it('касание границы расширенной области не считается пересечением', () => {
    expect(snapCandidates(box, [touching], 50)).toEqual([])
  })

  it('нулевой радиус — только реально пересекающиеся', () => {
    expect(snapCandidates(box, [near1, r(50, 50, 200, 200)], 0)).toEqual([r(50, 50, 200, 200)])
  })

  it('пустой вход', () => {
    expect(snapCandidates(box, [], 10)).toEqual([])
  })
})
