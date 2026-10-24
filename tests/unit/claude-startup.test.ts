import { describe, expect, it } from 'vitest'
import { claudeStartupAnswer } from '../../src/main/agents/builtin/claude'
import { edgeNotices } from '@core/edge-notices'
import { makeEdge, makeNode } from '@core/ops'

const dialog = (cursorOn: 1 | 2): string =>
  [
    'WARNING: Loading development channels',
    '',
    '--dangerously-load-development-channels is for local channel development only.',
    '',
    'Channels: server:cnv',
    '',
    `${cursorOn === 1 ? '❯' : ' '} 1. I am using this for local development`,
    `${cursorOn === 2 ? '❯' : ' '} 2. Exit`,
    '',
    'Enter to confirm · Esc to cancel'
  ].join('\n')

describe('стартовый диалог Claude Code', () => {
  it('подтверждение канала cnv — Enter, только когда курсор на «local development»', () => {
    expect(claudeStartupAnswer(dialog(1))).toBe('\r')
    expect(claudeStartupAnswer(dialog(2))).toBeNull()
    expect(claudeStartupAnswer(dialog(1).replace('server:cnv', 'server:evil'))).toBeNull()
    expect(claudeStartupAnswer('────────────\n❯ привет')).toBeNull()
  })
})

describe('письмо о связях', () => {
  it('название карточки — без markdown', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 }
    const a = makeNode({ type: 'terminal', shell: 'sh', name: 'Даня', agent: { sessionId: '' } }, rect)
    const card = makeNode({ type: 'text', text: '## 🧠 **Модель** агента · `сброс`' }, rect)
    const doc = { nodes: [a, card], edges: [], extra: {} }
    const [notice] = edgeNotices(doc, { ...doc, edges: [makeEdge(a.id, card.id)] })
    expect(notice?.text).toContain('карточка «🧠 Модель агента · сброс»')
  })
})
