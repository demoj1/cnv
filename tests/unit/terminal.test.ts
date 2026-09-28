import { describe, expect, it } from 'vitest'
import type { DocNode } from '@core/document'
import { nodeKind } from '@core/node-kind'
import { makeNode } from '@core/ops'
import { isTerminal, terminalPlaceholder, terminalSpec, withTerminalSpec } from '@core/terminal'

const text = (extra: Record<string, unknown> = {}): DocNode => ({
  id: 'n1',
  type: 'text',
  text: 'обычная карточка',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  extra
})

describe('опознание терминала', () => {
  it('обычная текстовая нода терминалом не является', () => {
    expect(isTerminal(text())).toBe(false)
    expect(nodeKind(text())).toBe('text')
  })

  it('помеченная нода опознаётся и остаётся текстовой для Obsidian', () => {
    const node = text(withTerminalSpec({}, {}))
    expect(isTerminal(node)).toBe(true)
    expect(nodeKind(node)).toBe('terminal')
    expect(node.type).toBe('text')
  })

  it('рабочая папка читается и пишется', () => {
    const node = text(withTerminalSpec({}, { cwd: '/tmp' }))
    expect(terminalSpec(node)).toEqual({ cwd: '/tmp' })
  })

  it('чужие поля в x-cnv не затираются', () => {
    const extra = withTerminalSpec({ 'x-cnv': { чужое: 1 } }, { cwd: '/tmp' })
    expect(extra['x-cnv']).toEqual({ чужое: 1, terminal: { cwd: '/tmp' } })
  })

  it('мусор в поле не считается терминалом', () => {
    expect(isTerminal(text({ 'x-cnv': 'строка' }))).toBe(false)
    expect(isTerminal(text({ 'x-cnv': { terminal: 5 } }))).toBe(false)
    expect(isTerminal(text({ 'x-cnv': {} }))).toBe(false)
  })

  it('не-текстовая нода терминалом быть не может', () => {
    const link: DocNode = { ...text(withTerminalSpec({}, {})), type: 'link', url: 'https://a' } as DocNode
    expect(isTerminal(link)).toBe(false)
  })
})

describe('создание терминальной ноды', () => {
  it('это текстовая нода с пометкой и читаемой подписью', () => {
    const node = makeNode(
      { type: 'terminal', shell: 'zsh', cwd: '/tmp' },
      { x: 1, y: 2, width: 3, height: 4 }
    )
    expect(node.type).toBe('text')
    expect(nodeKind(node)).toBe('terminal')
    expect(terminalSpec(node)).toEqual({ cwd: '/tmp' })
    if (node.type === 'text') expect(node.text).toBe(terminalPlaceholder('zsh'))
  })

  it('без папки создаётся пустая пометка, а не мусор', () => {
    const node = makeNode({ type: 'terminal', shell: 'sh' }, { x: 0, y: 0, width: 1, height: 1 })
    expect(terminalSpec(node)).toEqual({})
  })
})
