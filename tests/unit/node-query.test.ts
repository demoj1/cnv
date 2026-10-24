import { describe, expect, it } from 'vitest'
import type { AgentEdge, AgentNode } from '@shared/agent'
import { queryNodes } from '@core/node-query'

const n = (id: string, over: Partial<AgentNode>): AgentNode => ({
  id,
  kind: 'text',
  desktop: 1,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...over
})

const nodes: AgentNode[] = [
  n('g', { kind: 'group', label: 'Телефоны', x: 0, y: 0, width: 1000, height: 500 }),
  n('a', { text: 'Pixel 9 — 59 990 ₽', color: '4', x: 10, y: 10 }),
  n('b', { text: 'iPhone 16', color: '1', x: 200, y: 10 }),
  n('c', { text: 'Заметки', x: 2000, y: 10, desktop: 2 }),
  n('t', { kind: 'agent', name: 'Бесстрашная Прасковья', role: 'аналитик', x: 2000, y: 600 })
]
const edges: AgentEdge[] = [{ id: 'e', fromNode: 't', toNode: 'c' }]

const ids = (q: Parameters<typeof queryNodes>[2]): string[] => queryNodes(nodes, edges, q).map((x) => x.id)

describe('поиск нод', () => {
  it('по подстроке и по регулярке, без регистра', () => {
    expect(ids({ text: 'pixel' })).toEqual(['a'])
    expect(ids({ text: '/\\d{2} \\d{3} ₽/' })).toEqual(['a'])
  })

  it('текст ищется и в имени, роли, подписи группы', () => {
    expect(ids({ text: 'аналит' })).toEqual(['t'])
    expect(ids({ text: 'телефоны' })).toEqual(['g'])
  })

  it('по цвету и без цвета', () => {
    expect(ids({ color: '1' })).toEqual(['b'])
    expect(ids({ color: 'none', kinds: ['text'] })).toEqual(['c'])
  })

  it('по группе (id или подпись) — только то, что целиком внутри', () => {
    expect(ids({ group: 'Телефоны' })).toEqual(['a', 'b'])
    expect(ids({ group: 'g', color: '4' })).toEqual(['a'])
  })

  it('по области, столу и связи', () => {
    expect(ids({ within: { x: 0, y: 0, width: 150, height: 100 } })).toEqual(['a'])
    expect(ids({ intersects: { x: 150, y: 0, width: 100, height: 100 }, kinds: ['text'] })).toEqual(['b'])
    expect(ids({ desktop: 2 })).toEqual(['c'])
    expect(ids({ connectedTo: 'Прасковья' })).toEqual(['c'])
  })

  it('нет группы — понятная ошибка', () => {
    expect(() => ids({ group: 'Ноутбуки' })).toThrow('нет группы')
  })
})
