import { describe, expect, it } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeEdge, makeNode } from '@core/ops'
import { nodeKind } from '@core/node-kind'
import { portalFileName } from '../../src/main/mcp/tools'
import {
  ackTimeoutMs,
  formatFingerprint,
  newPortalKey,
  normalizePortalKey,
  portalMembers,
  portalSpec,
  portalsOf,
  withPortalSpec
} from '@core/portal'

const rect = { x: 0, y: 0, width: 10, height: 10 }

describe('портал', () => {
  it('ключ: 4 группы по 4 знака без похожих символов, каждый раз новый', () => {
    let i = 0
    const random = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => (i += 37) % 256)
    const key = newPortalKey(random)
    expect(key).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/)
    expect(newPortalKey(random)).not.toBe(key)
    expect(normalizePortalKey('  ABCD EFGH  ')).toBe('ABCD-EFGH')
  })

  it('нода портала: свой вид, ключ и доверенные в x-cnv', () => {
    const p = makeNode({ type: 'portal', key: 'K', label: 'Дверь' }, rect)
    expect(nodeKind(p)).toBe('portal')
    expect(portalSpec(p)).toEqual({ key: 'K', label: 'Дверь', trusted: [] })
    const trusted = {
      ...p,
      extra: withPortalSpec(p.extra, { trusted: [{ fingerprint: 'ab', name: 'Пети', at: 1 }] })
    }
    expect(portalSpec(trusted)?.trusted).toEqual([{ fingerprint: 'ab', name: 'Пети', at: 1 }])
    expect(portalSpec(makeNode({ type: 'text', text: 'x' }, rect))).toBeNull()
  })

  it('через портал видно только тех, кто соединён с ним стрелкой', () => {
    const p = { ...makeNode({ type: 'portal', key: 'K' }, rect), id: 'p' }
    const a = {
      ...makeNode({ type: 'terminal', shell: 'sh', name: 'Агент', agent: { sessionId: '' } }, rect),
      id: 'a'
    }
    const t = { ...makeNode({ type: 'terminal', shell: 'sh', name: 'Терм' }, rect), id: 't' }
    const hidden = { ...makeNode({ type: 'terminal', shell: 'sh', name: 'Тайный' }, rect), id: 'h' }
    const card = { ...makeNode({ type: 'text', text: 'карточка' }, rect), id: 'c' }
    const doc: CanvasDoc = {
      nodes: [p, a, t, hidden, card],
      edges: [makeEdge('a', 'p'), makeEdge('p', 't'), makeEdge('p', 'c')],
      extra: {}
    }
    expect(portalMembers(doc, 'p')).toEqual([
      { id: 'a', name: 'Агент', kind: 'agent' },
      { id: 't', name: 'Терм', kind: 'terminal' }
    ])
    expect(portalsOf(doc, 'a').map((n) => n.id)).toEqual(['p'])
    expect(portalsOf(doc, 'h')).toEqual([])
  })

  it('отпечаток для людей', () => {
    expect(formatFingerprint('c0323fbb8170aa')).toBe('C032-3FBB-8170')
  })
})

describe('доставка через портал', () => {
  it('имя файла с той стороны — как есть, без путей и управляющих символов', () => {
    expect(portalFileName('файл с пробелами [1].txt')).toBe('файл с пробелами [1].txt')
    expect(portalFileName('../../etc/passwd')).toBe('passwd')
    expect(portalFileName('C:\\Users\\x\\отчёт (2).pdf')).toBe('отчёт (2).pdf')
    expect(portalFileName('a\nb\u0007.txt')).toBe('a_b_.txt')
    expect(portalFileName('..')).toBe('file')
    expect(portalFileName('')).toBe('file')
  })

  it('ждём подтверждения дольше для больших писем', () => {
    expect(ackTimeoutMs(1000)).toBeGreaterThanOrEqual(10_000)
    expect(ackTimeoutMs(10_400_000)).toBeGreaterThan(ackTimeoutMs(1000) + 30_000)
  })
})
