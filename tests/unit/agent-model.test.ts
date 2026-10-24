import { describe, expect, it } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeNode } from '@core/ops'
import { applyNodePatch, toAgentNode } from '@core/agent-ops'
import { terminalSpec, withoutAgentPrompt } from '@core/terminal'
import { withModel } from '../../src/main/agents/builtin/model'

const q = (v: string): string => `'${v}'`

describe('модель агента', () => {
  it('в команде: своя модель вместо прописанной, без модели — как есть', () => {
    expect(withModel('opencode -m opencode/free-x', 'anthropic/claude-haiku', q)).toBe(
      "opencode --model 'anthropic/claude-haiku'"
    )
    expect(withModel('claude --model=opus --verbose', 'haiku', q)).toBe("claude --verbose --model 'haiku'")
    expect(withModel('codex', undefined, q)).toBe('codex')
  })

  it('патч: модель в спеке, сессия не теряется, пустая — снять; кривая — ошибка', () => {
    const agent = makeNode(
      { type: 'terminal', shell: 'sh', name: 'Даня', agent: { sessionId: 's1', plugin: 'claude' } },
      { x: 0, y: 0, width: 10, height: 10 }
    )
    const doc: CanvasDoc = { nodes: [agent], edges: [], extra: {} }
    const next = applyNodePatch(doc, agent.id, { model: 'haiku' })
    expect(terminalSpec(next.nodes[0]!)?.agent).toEqual({ sessionId: 's1', plugin: 'claude', model: 'haiku' })
    expect(toAgentNode(next.nodes[0]!).model).toBe('haiku')
    // Первое задание стирается, а модель остаётся.
    const spec = terminalSpec(next.nodes[0]!)!.agent!
    expect(withoutAgentPrompt({}, { ...spec, prompt: 'x' })).toMatchObject({
      'x-cnv': { terminal: { agent: { model: 'haiku' } } }
    })
    const reset = applyNodePatch(next, agent.id, { model: '', sessionId: '' })
    expect(terminalSpec(reset.nodes[0]!)?.agent).toEqual({ sessionId: '', plugin: 'claude' })
    expect(() => applyNodePatch(doc, agent.id, { model: 'haiku; rm -rf /' })).toThrow('кривое имя модели')
  })
})
