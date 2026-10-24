import { describe, expect, it } from 'vitest'
import {
  AgentOpError,
  applyEdgePatch,
  applyNodePatch,
  buildEdge,
  buildNode,
  placeRect,
  splitIds,
  toAgentNode
} from '@core/agent-ops'
import type { CanvasDoc, DocNode } from '@core/document'
import { makeNode } from '@core/ops'
import { terminalSpec } from '@core/terminal'

const rect = { x: 0, y: 0, width: 100, height: 50 }
const viewport = { x: 0, y: 0, width: 1000, height: 800 }
const opts = { shell: 'zsh', defaultAgent: 'claude' }

function doc(...nodes: DocNode[]): CanvasDoc {
  return { nodes, edges: [], extra: {} }
}

describe('нода глазами агента', () => {
  it('текст режется по лимиту с пометкой', () => {
    const n = makeNode({ type: 'text', text: 'абвгд' }, rect)
    expect(toAgentNode(n, 3)).toMatchObject({ kind: 'text', text: 'абв', truncated: true })
    expect(toAgentNode(n)).toMatchObject({ text: 'абвгд' })
    expect(toAgentNode(n).truncated).toBeUndefined()
  })

  it('агент виден как agent с именем и видом агента, а не как текст', () => {
    const n = buildNode(doc(), { kind: 'agent', name: 'Хитрый Фома', cwd: '/tmp' }, rect, opts)
    expect(toAgentNode(n)).toMatchObject({ kind: 'agent', name: 'Хитрый Фома', cwd: '/tmp', agent: 'claude' })
    // Сессии ещё нет — агент её начнёт сам.
    expect(toAgentNode(n).sessionId).toBeUndefined()
    expect(toAgentNode(n).text).toBeUndefined()
  })
})

describe('создание нод агентом', () => {
  it('терминал без имени получает уникальное', () => {
    const a = buildNode(doc(), { kind: 'terminal' }, rect, opts)
    const b = buildNode(doc(a), { kind: 'terminal' }, rect, opts)
    expect(terminalSpec(a)?.name).toBeTruthy()
    expect(terminalSpec(b)?.name).not.toBe(terminalSpec(a)?.name)
  })

  it('занятое имя — ошибка', () => {
    const a = buildNode(doc(), { kind: 'terminal', name: 'Тихая Нина' }, rect, opts)
    expect(() => buildNode(doc(a), { kind: 'agent', name: 'Тихая Нина' }, rect, opts)).toThrow(AgentOpError)
  })

  it('первое задание агента хранится до запуска', () => {
    const n = buildNode(doc(), { kind: 'agent', prompt: 'сделай чай' }, rect, opts)
    expect(terminalSpec(n)?.agent).toEqual({ plugin: 'claude', sessionId: '', prompt: 'сделай чай' })
  })

  it('вид агента из запроса, иначе — по умолчанию', () => {
    const n = buildNode(doc(), { kind: 'agent', agent: 'codex' }, rect, opts)
    expect(terminalSpec(n)?.agent?.plugin).toBe('codex')
  })

  it('агента можно перепривязать к другой сессии, не-агента — нельзя', () => {
    const agent = buildNode(doc(), { kind: 'agent', agent: 'claude' }, rect, opts)
    const d = applyNodePatch(doc(agent), agent.id, { sessionId: 'cfdefbc3-2c15-41da-88ef-68227479d743' })
    expect(terminalSpec(d.nodes[0]!)?.agent).toEqual({
      plugin: 'claude',
      sessionId: 'cfdefbc3-2c15-41da-88ef-68227479d743'
    })
    const term = buildNode(doc(), { kind: 'terminal' }, rect, opts)
    expect(() => applyNodePatch(doc(term), term.id, { sessionId: 'abcd' })).toThrow(AgentOpError)
    expect(() => applyNodePatch(doc(agent), agent.id, { sessionId: 'x; rm -rf ~' })).toThrow(AgentOpError)
  })

  it('веб только по http(s)', () => {
    expect(() => buildNode(doc(), { kind: 'web', url: 'file:///etc/passwd' }, rect, opts)).toThrow(
      AgentOpError
    )
  })
})

describe('куда встаёт новая нода', () => {
  it('явные координаты — как есть', () => {
    expect(placeRect(doc(), { x: 5, y: 6 }, { width: 10, height: 20 }, viewport)).toEqual({
      x: 5,
      y: 6,
      width: 10,
      height: 20
    })
  })

  it('без якоря — в центр экрана', () => {
    expect(placeRect(doc(), {}, { width: 100, height: 100 }, viewport)).toEqual({
      x: 450,
      y: 350,
      width: 100,
      height: 100
    })
  })

  it('рядом с якорем справа, а если занято — ниже', () => {
    const anchor = {
      ...makeNode({ type: 'text', text: '' }, { x: 0, y: 0, width: 100, height: 100 }),
      id: 'a'
    }
    const free = placeRect(doc(anchor), { near: 'a' }, { width: 50, height: 50 }, viewport)
    expect(free).toMatchObject({ x: 140, y: 0 })
    const blocker = {
      ...makeNode({ type: 'text', text: '' }, { x: 140, y: 0, width: 50, height: 60 }),
      id: 'b'
    }
    const shifted = placeRect(doc(anchor, blocker), { near: 'a' }, { width: 50, height: 50 }, viewport)
    expect(shifted).toMatchObject({ x: 140, y: 100 })
  })

  it('несуществующий якорь — ошибка', () => {
    expect(() => placeRect(doc(), { near: 'нет' }, { width: 1, height: 1 }, viewport)).toThrow(AgentOpError)
  })
})

describe('правки агента', () => {
  const text = { ...makeNode({ type: 'text', text: 'старое' }, rect), id: 't' }
  const term = { ...buildNode(doc(), { kind: 'terminal', name: 'Бодрый Олег' }, rect, opts), id: 'term' }

  it('текст, цвет и геометрия', () => {
    const next = applyNodePatch(doc(text), 't', { text: 'новое', color: '3', x: 10 })
    expect(next.nodes[0]).toMatchObject({ text: 'новое', color: '3', x: 10 })
    const cleared = applyNodePatch(next, 't', { color: null })
    expect(cleared.nodes[0]!.color).toBeUndefined()
  })

  it('поле не по виду ноды — ошибка, а не тишина', () => {
    expect(() => applyNodePatch(doc(text), 't', { url: 'https://a' })).toThrow('не веб')
    expect(() => applyNodePatch(doc(term), 'term', { text: 'x' })).toThrow('нет текста')
    expect(() => applyNodePatch(doc(text), 't', { width: 0 })).toThrow('> 0')
  })

  it('терминал переименовывается, но не в занятое имя', () => {
    const other = { ...buildNode(doc(), { kind: 'terminal', name: 'Сонная Раиса' }, rect, opts), id: 'o' }
    const renamed = applyNodePatch(doc(term, other), 'term', { name: 'Лихой Макар' })
    expect(terminalSpec(renamed.nodes[0]!)?.name).toBe('Лихой Макар')
    expect(() => applyNodePatch(doc(term, other), 'term', { name: 'Сонная Раиса' })).toThrow('занято')
  })

  it('связь: только между живыми нодами, правка подписи и снятие', () => {
    const d = doc(text, term)
    expect(() => buildEdge(d, { fromNode: 't', toNode: 'нет' })).toThrow(AgentOpError)
    const edge = buildEdge(d, { fromNode: 't', toNode: 'term', label: 'ведёт', toEnd: 'arrow' })
    const withEdge = { ...d, edges: [edge] }
    expect(applyEdgePatch(withEdge, edge.id, { label: null }).edges[0]!.label).toBeUndefined()
  })

  it('смешанный список id раскладывается на ноды и связи', () => {
    const edge = buildEdge(doc(text, term), { fromNode: 't', toNode: 'term' })
    const d = { ...doc(text, term), edges: [edge] }
    expect(splitIds(d, ['t', edge.id])).toEqual({ nodes: ['t'], edges: [edge.id] })
    expect(() => splitIds(d, ['левак'])).toThrow(AgentOpError)
  })
})
