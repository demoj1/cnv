import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MessageBox, type AgentMessage } from '../../src/main/mcp/messages'
import { editText } from '../../src/main/mcp/tools'
import { changelogSection, greetingText } from '../../src/main/mcp/greeting'

const msg = (id: string, from: string, to: string, at: number, replyTo?: string): AgentMessage => ({
  id,
  from,
  fromName: null,
  to,
  text: id,
  ...(replyTo ? { replyTo } : {}),
  attachments: [],
  at
})

describe('почта агентов', () => {
  it('переживает перезапуск: журнал на диске', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-mail-')), 'messages.jsonl')
    new MessageBox(file).post(msg('m1', 'a', 'b', 1))
    const again = new MessageBox(file)
    expect(again.get('m1')?.text).toBe('m1')
  })

  it('wait_reply не отдаёт один и тот же ответ дважды — второй раз ждёт следующий', async () => {
    const box = new MessageBox()
    const q = box.post(msg('q', 'a', 'b', 1))
    box.post(msg('r1', 'b', 'a', 2, 'q'))
    expect((await box.waitReply(q, 50))?.id).toBe('r1')
    expect(await box.waitReply(q, 50)).toBeNull()
    box.post(msg('r2', 'b', 'a', 3, 'q'))
    expect((await box.waitReply(q, 50))?.id).toBe('r2')
  })

  it('ждать ответа на любое из нескольких писем', async () => {
    const box = new MessageBox()
    const toB = box.post(msg('q1', 'a', 'b', 1))
    const toC = box.post(msg('q2', 'a', 'c', 1))
    const waiting = box.waitReply([toB, toC], 1000)
    box.post(msg('rc', 'c', 'a', 2, 'q2'))
    expect((await waiting)?.id).toBe('rc')
  })

  it('отправленные и переписка вокруг письма', () => {
    const box = new MessageBox()
    box.post(msg('q', 'a', 'b', 1))
    box.post(msg('r', 'b', 'a', 2, 'q'))
    box.post(msg('rr', 'a', 'b', 3, 'r'))
    box.post(msg('other', 'c', 'a', 4))
    expect(box.inbox('a').map((m) => m.id)).toEqual(['r', 'other'])
    expect(box.inbox('a', undefined, true).map((m) => m.id)).toEqual(['q', 'r', 'rr', 'other'])
    expect(box.thread('r').map((m) => m.id)).toEqual(['q', 'r', 'rr'])
  })
})

describe('правка текста карточки кусками', () => {
  it('edits — замена ровно одного вхождения, append — с новой строки', () => {
    expect(editText('лог\nшаг 1', [{ old: 'шаг 1', new: 'шаг 1 ✓' }], 'шаг 2')).toBe('лог\nшаг 1 ✓\nшаг 2')
    expect(editText('', [], 'первая')).toBe('первая')
    expect(() => editText('a a', [{ old: 'a', new: 'b' }])).toThrow(/не один раз/)
    expect(() => editText('abc', [{ old: 'x', new: 'y' }])).toThrow(/нет/)
  })
})

describe('приветствие после перезапуска', () => {
  const log = '# Changelog\n\n## 0.6.0 — новое\n\n- пункт\n\n## 0.5.3 — старое\n\n- было'
  it('без смены версии — коротко, с новой — что нового', () => {
    expect(changelogSection(log, '0.6.0')).toBe('- пункт')
    expect(greetingText('0.6.0', '0.6.0', log)).not.toContain('что нового')
    expect(greetingText('0.6.0', '0.5.3', log)).toContain('0.5.3 → 0.6.0, что нового:\n- пункт')
  })
})
