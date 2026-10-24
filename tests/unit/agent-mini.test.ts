import { describe, expect, it } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeNode } from '@core/ops'
import { collapseAgent, expandAgent, isCollapsed, MINI_SIZE, normalizeIcon } from '@core/agent-mini'
import { applyNodePatch, toAgentNode } from '@core/agent-ops'
import { terminalSpec } from '@core/terminal'

const agent = makeNode(
  { type: 'terminal', shell: 'sh', name: 'Даня', agent: { sessionId: 's1' } },
  { x: 100, y: 200, width: 720, height: 420 }
)
const doc: CanvasDoc = { nodes: [agent], edges: [], extra: {} }

describe('свёрнутый агент', () => {
  it('сворачивается в кружок по центру и разворачивается в прежнее окно', () => {
    const mini = collapseAgent(agent)
    expect(isCollapsed(mini)).toBe(true)
    expect({ w: mini.width, h: mini.height }).toEqual({ w: MINI_SIZE.width, h: MINI_SIZE.height })
    expect(mini.x + mini.width / 2).toBe(agent.x + agent.width / 2)
    const back = expandAgent(mini)
    expect(isCollapsed(back)).toBe(false)
    expect([back.x, back.y, back.width, back.height]).toEqual([agent.x, agent.y, agent.width, agent.height])
    // Сессия агента при этом не теряется.
    expect(terminalSpec(back)?.agent?.sessionId).toBe('s1')
    // Терминал без агента не сворачивается.
    const term = makeNode({ type: 'terminal', shell: 'sh' }, agent)
    expect(collapseAgent(term)).toBe(term)
  })

  it('значок — первый символ, emoji с модификаторами целиком', () => {
    expect(normalizeIcon('  🧑‍💻 тест')).toBe('🧑‍💻')
    expect(normalizeIcon('📱')).toBe('📱')
    expect(normalizeIcon('   ')).toBe('')
  })

  it('патч MCP: значок, статус, сворачивание — и видно в toAgentNode', () => {
    let next = applyNodePatch(doc, agent.id, { icon: '🧪', status: { progress: 140, text: 'тесты 3/7' } })
    next = applyNodePatch(next, agent.id, { collapsed: true })
    const view = toAgentNode(next.nodes[0]!)
    expect(view).toMatchObject({ icon: '🧪', collapsed: true, status: { progress: 100, text: 'тесты 3/7' } })
    const cleared = toAgentNode(
      applyNodePatch(next, agent.id, { status: null, icon: '', collapsed: false }).nodes[0]!
    )
    expect(cleared).not.toHaveProperty('status')
    expect(cleared).not.toHaveProperty('icon')
    expect(cleared).toMatchObject({ width: 720, height: 420 })
    const card: CanvasDoc = { ...doc, nodes: [makeNode({ type: 'text', text: 'x' }, agent)] }
    expect(() => applyNodePatch(card, card.nodes[0]!.id, { icon: '🧪' })).toThrow('не агент')
  })
})

describe('имена по умолчанию', () => {
  it('терминал — номер, страница — домен, агент — человеческое', async () => {
    const { freshName } = await import('@core/terminal-identity')
    const taken = new Set(['Терминал 1', 'ifconfig.me'])
    expect(freshName(makeNode({ type: 'terminal', shell: 'sh' }, agent), taken)).toBe('Терминал 2')
    expect(freshName(makeNode({ type: 'link', url: 'https://www.ozon.ru/x' }, agent), taken)).toBe('ozon.ru')
    expect(freshName(makeNode({ type: 'link', url: 'https://ifconfig.me' }, agent), taken)).toBe('ifconfig.me 2')
    expect(freshName(agent, taken, () => 0)).toMatch(/^\S+ \S+$/)
  })
})
