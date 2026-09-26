import { describe, expect, it } from 'vitest'
import type { CanvasDoc, DocNode } from '@core/document'
import {
  cubicAt,
  defaultSides,
  distanceToEdge,
  edgeGeometry,
  endAngle,
  resolveEdges,
  staleEdgeSides
} from '@core/edges'
import type { Rect } from '@core/geometry'

const r = (x: number, y: number, width = 100, height = 60): Rect => ({ x, y, width, height })

function node(id: string, x: number, y: number): DocNode {
  return { id, type: 'text', text: id, x, y, width: 100, height: 60, extra: {} }
}

describe('стороны по умолчанию', () => {
  it('смотрят друг на друга', () => {
    expect(defaultSides(r(0, 0), r(400, 0))).toEqual({ fromSide: 'right', toSide: 'left' })
    expect(defaultSides(r(400, 0), r(0, 0))).toEqual({ fromSide: 'left', toSide: 'right' })
    expect(defaultSides(r(0, 0), r(0, 400))).toEqual({ fromSide: 'bottom', toSide: 'top' })
    expect(defaultSides(r(0, 400), r(0, 0))).toEqual({ fromSide: 'top', toSide: 'bottom' })
  })
})

describe('геометрия ребра', () => {
  it('начинается и заканчивается на серединах сторон', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0))
    expect(g.from).toEqual({ x: 100, y: 30 })
    expect(g.to).toEqual({ x: 400, y: 30 })
  })

  it('уважает явно заданные стороны', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0), 'top', 'bottom')
    expect(g.fromSide).toBe('top')
    expect(g.from).toEqual({ x: 50, y: 0 })
    expect(g.to).toEqual({ x: 450, y: 60 })
  })

  it('путь — кубическая кривая от начала до конца', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0))
    expect(g.path.startsWith('M 100 30 C ')).toBe(true)
    expect(g.path.endsWith('400 30')).toBe(true)
  })

  it('подпись садится на середину кривой', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0))
    expect(g.labelAt.x).toBeGreaterThan(g.from.x)
    expect(g.labelAt.x).toBeLessThan(g.to.x)
    expect(g.labelAt.y).toBeCloseTo(30, 6)
  })

  it('совпадающие ноды не дают NaN', () => {
    const g = edgeGeometry(r(0, 0), r(0, 0))
    expect(Number.isFinite(g.labelAt.x)).toBe(true)
    expect(Number.isFinite(g.labelAt.y)).toBe(true)
  })
})

describe('cubicAt', () => {
  it('на концах совпадает с опорными точками', () => {
    const p0 = { x: 0, y: 0 }
    const p3 = { x: 10, y: 10 }
    expect(cubicAt(p0, { x: 3, y: 0 }, { x: 7, y: 10 }, p3, 0)).toEqual(p0)
    expect(cubicAt(p0, { x: 3, y: 0 }, { x: 7, y: 10 }, p3, 1)).toEqual(p3)
  })
})

describe('углы стрелок', () => {
  it('смотрят наружу от стороны', () => {
    expect(endAngle('right')).toBe(0)
    expect(endAngle('bottom')).toBe(90)
    expect(endAngle('left')).toBe(180)
    expect(endAngle('top')).toBe(-90)
  })
})

describe('resolveEdges', () => {
  const doc = (edges: CanvasDoc['edges']): CanvasDoc => ({
    nodes: [node('a', 0, 0), node('b', 400, 0)],
    edges,
    extra: {}
  })

  it('считает геометрию для валидных рёбер', () => {
    const resolved = resolveEdges(doc([{ id: 'e1', fromNode: 'a', toNode: 'b', extra: {} }]))
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.geometry.fromSide).toBe('right')
  })

  it('ребро в несуществующую ноду просто не рисуется', () => {
    expect(resolveEdges(doc([{ id: 'e1', fromNode: 'a', toNode: 'нет', extra: {} }]))).toHaveLength(0)
  })
})

describe('попадание по ребру', () => {
  it('точка на кривой ближе, чем точка в стороне', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0))
    expect(distanceToEdge(g, { x: 250, y: 30 })).toBeLessThan(2)
    expect(distanceToEdge(g, { x: 250, y: 200 })).toBeGreaterThan(100)
  })

  it('концы кривой считаются попаданием', () => {
    const g = edgeGeometry(r(0, 0), r(400, 0))
    expect(distanceToEdge(g, g.from)).toBeLessThan(1)
    expect(distanceToEdge(g, g.to)).toBeLessThan(1)
  })
})

describe('автоподбор сторон', () => {
  const swapped: CanvasDoc = {
    // b теперь слева от a, хотя связь была записана как «из правого края a в левый край b»
    nodes: [node('a', 400, 0), node('b', 0, 0)],
    edges: [{ id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', extra: {} }],
    extra: {}
  }

  it('по умолчанию слушается того, что записано в файле', () => {
    const [resolved] = resolveEdges(swapped)
    expect(resolved?.geometry.fromSide).toBe('right')
    expect(resolved?.geometry.toSide).toBe('left')
  })

  it('с автоподбором стороны разворачиваются навстречу друг другу', () => {
    const [resolved] = resolveEdges(swapped, true)
    expect(resolved?.geometry.fromSide).toBe('left')
    expect(resolved?.geometry.toSide).toBe('right')
  })

  it('разошедшиеся стороны видно отдельно и они не трогают совпавшие', () => {
    const stale = staleEdgeSides(swapped)
    expect(stale.get('e1')).toEqual({ fromSide: 'left', toSide: 'right' })

    const settled: CanvasDoc = {
      nodes: swapped.nodes,
      edges: [{ id: 'e1', fromNode: 'a', fromSide: 'left', toNode: 'b', toSide: 'right', extra: {} }],
      extra: {}
    }
    expect(staleEdgeSides(settled).size).toBe(0)
  })

  it('связь без записанных сторон тоже попадает в разошедшиеся', () => {
    const bare: CanvasDoc = {
      nodes: [node('a', 0, 0), node('b', 400, 0)],
      edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', extra: {} }],
      extra: {}
    }
    expect(staleEdgeSides(bare).get('e1')).toEqual({ fromSide: 'right', toSide: 'left' })
  })

  it('вертикальная пара разворачивается по вертикали', () => {
    const vertical: CanvasDoc = {
      nodes: [node('a', 0, 400), node('b', 0, 0)],
      edges: [{ id: 'e1', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', extra: {} }],
      extra: {}
    }
    const [resolved] = resolveEdges(vertical, true)
    expect(resolved?.geometry.fromSide).toBe('top')
    expect(resolved?.geometry.toSide).toBe('bottom')
  })
})
