import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentCommandLine, sessionExists, shellQuote } from '../../src/main/agent-session'

const id = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('запуск агента', () => {
  it('первый раз — новая сессия с заданием, потом — продолжение', () => {
    const first = agentCommandLine(
      { sessionId: id, prompt: "it's done" },
      { command: 'claude', mcpConfig: '/a b/c.json', resume: false, platform: 'linux' }
    )
    expect(first).toBe(`claude --mcp-config '/a b/c.json' --session-id ${id} 'it'\\''s done'`)
    const again = agentCommandLine(
      { sessionId: id, prompt: 'игнор' },
      { command: 'claude', mcpConfig: null, resume: true }
    )
    expect(again).toBe(`claude --resume ${id}`)
  })

  it('кривой id сессии в шелл не попадает', () => {
    expect(() =>
      agentCommandLine({ sessionId: 'x; rm -rf ~' }, { command: 'claude', mcpConfig: null, resume: true })
    ).toThrow()
  })

  it('кавычки под windows', () => {
    expect(shellQuote('a "b"', 'win32')).toBe('"a \\"b\\""')
  })

  it('сессия ищется в любой папке проектов', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-claude-'))
    try {
      expect(sessionExists(id, home)).toBe(false)
      fs.mkdirSync(path.join(home, 'projects', '-home-me-proj'), { recursive: true })
      fs.writeFileSync(path.join(home, 'projects', '-home-me-proj', `${id}.jsonl`), '')
      expect(sessionExists(id, home)).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
