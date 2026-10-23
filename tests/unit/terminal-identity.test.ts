import { describe, expect, it } from 'vitest'
import type { CanvasDoc, DocNode } from '@core/document'
import { NAME_SPACE_SIZE, uniqueName } from '@core/names'
import { makeNode } from '@core/ops'
import { terminalSpec } from '@core/terminal'
import { assignTerminalIdentities, findTerminal } from '@core/terminal-identity'

const rect = { x: 0, y: 0, width: 10, height: 10 }
const term = (id: string, name?: string, sessionId?: string): DocNode => ({
  ...makeNode(
    {
      type: 'terminal',
      shell: 'sh',
      ...(name ? { name } : {}),
      ...(sessionId ? { agent: { sessionId } } : {})
    },
    rect
  ),
  id
})
const doc = (...nodes: DocNode[]): CanvasDoc => ({ nodes, edges: [], extra: {} })
let counter = 0
const newSession = (): string => `s-${++counter}`

describe('имена', () => {
  it('прилагательное согласовано с родом имени', () => {
    for (let i = 0; i < 200; i++) {
      const [adj, name] = uniqueName(new Set()).split(' ') as [string, string]
      const feminine = /[ая]$/.test(name) && !['Фома', 'Кузьма'].includes(name)
      expect(adj.endsWith('ая') || adj.endsWith('яя')).toBe(feminine)
    }
  })

  it('не повторяет занятые даже при тесноте', () => {
    const taken = new Set<string>()
    for (let i = 0; i < NAME_SPACE_SIZE + 50; i++) {
      const name = uniqueName(taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
  })
})

describe('уникальность терминалов на холсте', () => {
  it('безымянный получает имя, документ без терминалов не трогается', () => {
    const plain = doc({ ...makeNode({ type: 'text', text: '' }, rect), id: 'x' })
    expect(assignTerminalIdentities(plain, newSession)).toBe(plain)
    const fixed = assignTerminalIdentities(doc(term('a')), newSession)
    expect(terminalSpec(fixed.nodes[0]!)?.name).toBeTruthy()
  })

  it('уже уникальное — тот же объект документа', () => {
    const d = doc(term('a', 'Тихий Олег'), term('b', 'Хмурая Нина', 'sid'))
    expect(assignTerminalIdentities(d, newSession)).toBe(d)
  })

  it('у копии — новое имя и новая сессия, оригинал не меняется', () => {
    const d = doc(term('a', 'Тихий Олег', 'sid'), term('b', 'Тихий Олег', 'sid'))
    const fixed = assignTerminalIdentities(d, newSession)
    const [a, b] = fixed.nodes.map((n) => terminalSpec(n)!)
    expect(a).toMatchObject({ name: 'Тихий Олег', agent: { sessionId: 'sid' } })
    expect(b!.name).not.toBe('Тихий Олег')
    expect(b!.agent?.sessionId).toMatch(/^s-/)
  })

  it('поиск по id и по имени без учёта регистра', () => {
    const d = doc(term('a', 'Тихий Олег'))
    expect(findTerminal(d, 'a')?.id).toBe('a')
    expect(findTerminal(d, 'тихий олег')?.id).toBe('a')
    expect(findTerminal(d, 'Громкий Олег')).toBeUndefined()
  })
})
