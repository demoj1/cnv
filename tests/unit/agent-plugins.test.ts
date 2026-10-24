import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContext, AgentMcp, AgentPlugin } from '@shared/agent-plugin'
import { agentSystemPrompt, shellQuote } from '../../src/main/agent-session'
import {
  claudePlugin,
  claudeProjectDir,
  claudeSessionExists,
  listClaudeSessions
} from '../../src/main/agents/builtin/claude'
import { codexPlugin, codexSessionExists, findCodexSession } from '../../src/main/agents/builtin/codex'
import { opencodePlugin } from '../../src/main/agents/builtin/opencode'
import { AgentRegistry, validatePlugin } from '../../src/main/agents/registry'
import { AgentLauncher } from '../../src/main/agents/launcher'

const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

const mcp: AgentMcp = {
  url: 'http://127.0.0.1:4000/mcp',
  tokenEnv: 'CNV_MCP_TOKEN',
  forwardEnv: ['CNV_MCP_URL', 'CNV_MCP_TOKEN', 'CNV_NODE_ID'],
  stdio: { command: '/bin/cnv', args: ['bridge.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
  configFile: '/a b/c.json',
  serverName: 'cnv',
  channels: false
}

function ctx(over: Partial<AgentContext> = {}): AgentContext {
  return {
    nodeId: 'n1',
    cwd: '/home/me/proj',
    command: 'agent',
    sessionId: id,
    systemPrompt: 'ты агент',
    mcp,
    platform: 'linux',
    quote: (v) => shellQuote(v, 'linux'),
    dataDir: os.tmpdir(),
    ...over
  }
}

describe('общее', () => {
  it('кавычки шелла: одинарная внутри, windows', () => {
    expect(shellQuote("it's", 'linux')).toBe(`'it'\\''s'`)
    expect(shellQuote('a "b"', 'win32')).toBe('"a \\"b\\""')
  })

  it('системный промпт с именем и ролью', () => {
    const prompt = agentSystemPrompt('Хитрый Фома', 'ревьюер')
    expect(prompt).toContain('«Хитрый Фома»')
    expect(prompt).toContain('Твоя роль: ревьюер.')
  })
})

describe('Claude Code', () => {
  it('новый — с заданной сессией и заданием, потом — --resume; промпт и MCP оба раза', () => {
    const start = claudePlugin.start(ctx({ command: 'claude', prompt: "it's done" }))
    expect(start).toBe(
      `claude --mcp-config '/a b/c.json' --append-system-prompt 'ты агент' --session-id ${id} 'it'\\''s done'`
    )
    expect(claudePlugin.resume(ctx({ command: 'claude', mcp: null }))).toBe(
      `claude --append-system-prompt 'ты агент' --resume ${id}`
    )
  })

  it('письма каналом — флаг dev-канала сервера холста', () => {
    const line = claudePlugin.resume(ctx({ command: 'claude', mcp: { ...mcp, channels: true } }))
    expect(line).toContain(`--dangerously-load-development-channels 'server:cnv'`)
    expect(claudePlugin.mcpChannel).toBe(true)
  })

  it('id сессии известен сразу, кривой в шелл не попадает', () => {
    expect(claudePlugin.getSession({ ...ctx(), startedAt: 0, taken: new Set() })).toBe(id)
    expect(() => claudePlugin.resume(ctx({ sessionId: 'x; rm -rf ~' }))).toThrow()
  })

  it('сессия ищется в любой папке проектов', () => {
    const home = tmp('cnv-claude-')
    try {
      expect(claudeSessionExists(id, home)).toBe(false)
      fs.mkdirSync(path.join(home, 'projects', '-home-me-proj'), { recursive: true })
      fs.writeFileSync(path.join(home, 'projects', '-home-me-proj', `${id}.jsonl`), '')
      expect(claudeSessionExists(id, home)).toBe(true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('сессии Claude для «Продолжить сессию…»', () => {
  it('папка проекта: всё, кроме латиницы и цифр, — дефисы', () => {
    expect(claudeProjectDir('/home/me/my.proj')).toBe('-home-me-my-proj')
  })

  it('свежие первыми, заголовок — ai-title или первое сообщение человека', () => {
    const home = tmp('cnv-claude-list-')
    try {
      const dir = path.join(home, 'projects', claudeProjectDir('/home/me/proj'))
      fs.mkdirSync(dir, { recursive: true })
      const a = '11111111-1111-1111-1111-111111111111'
      const b = '22222222-2222-2222-2222-222222222222'
      fs.writeFileSync(
        path.join(dir, `${a}.jsonl`),
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'Уголки для стойки' })}\n`
      )
      fs.writeFileSync(
        path.join(dir, `${b}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { content: 'посчитай   длину' } })}\n`
      )
      fs.utimesSync(path.join(dir, `${a}.jsonl`), new Date(1000), new Date(1000))
      expect(listClaudeSessions('/home/me/proj', home).map((s) => [s.id, s.title])).toEqual([
        [b, 'посчитай длину'],
        [a, 'Уголки для стойки']
      ])
      expect(listClaudeSessions('/elsewhere', home)).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('Codex', () => {
  let home: string
  beforeEach(() => {
    home = tmp('cnv-codex-')
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  function rollout(sid: string, cwd: string, when: Date, parent?: string): void {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const dir = path.join(
      home,
      'sessions',
      String(when.getFullYear()),
      pad(when.getMonth() + 1),
      pad(when.getDate())
    )
    fs.mkdirSync(dir, { recursive: true })
    const meta = {
      type: 'session_meta',
      payload: {
        id: sid,
        cwd,
        timestamp: when.toISOString(),
        ...(parent ? { parent_thread_id: parent } : {})
      }
    }
    fs.writeFileSync(path.join(dir, `rollout-x-${sid}.jsonl`), `${JSON.stringify(meta)}\n{"more":1}\n`)
  }

  it('холст по HTTP с токеном из env, промпт — developer_instructions', () => {
    const line = codexPlugin.start(ctx({ command: 'codex', prompt: 'привет' })) as string
    expect(line).toContain(
      `-c 'mcp_servers.cnv={url="http://127.0.0.1:4000/mcp",bearer_token_env_var="CNV_MCP_TOKEN"}'`
    )
    expect(line).toContain(`-c 'developer_instructions="ты агент"'`)
    expect(line.endsWith(`'привет'`)).toBe(true)
    expect(codexPlugin.resume(ctx({ command: 'codex', sessionId: 'abc-123-def' }))).toMatch(
      /^codex resume abc-123-def -c /
    )
  })

  it('сессия этого запуска — по папке и времени, мимо чужих, подагентов и занятых', () => {
    const now = new Date()
    const startedAt = now.getTime() - 1000
    rollout('old-session-1', '/home/me/proj', new Date(startedAt - 3_600_000))
    rollout('other-dir-01', '/home/me/other', now)
    rollout('child-thread', '/home/me/proj', now, 'parent-1')
    rollout('taken-sess-1', '/home/me/proj', now)
    rollout('mine-session', '/home/me/proj', new Date(now.getTime() + 10))
    const q = { ...ctx(), startedAt, taken: new Set(['taken-sess-1']) }
    expect(findCodexSession(q, home)).toBe('mine-session')
    expect(codexSessionExists('mine-session', home)).toBe(true)
    expect(codexSessionExists('nope', home)).toBe(false)
  })

  it('пока сессии нет — null', () => {
    expect(findCodexSession({ ...ctx(), startedAt: Date.now(), taken: new Set() }, home)).toBeNull()
  })
})

describe('OpenCode', () => {
  it('письмо — в сессию по HTTP API его сервера', async () => {
    const http = await import('node:http')
    const dataDir = tmp('cnv-oc-')
    let got: { url?: string; body?: string } = {}
    const line = await opencodePlugin.resume(
      ctx({ nodeId: 'oc1', dataDir, sessionId: 'ses_abc123', cwd: '/tmp' })
    )
    const port = Number(/--port (\d+)/.exec(line)?.[1])
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        got = { url: req.url ?? '', body }
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
    try {
      const ok = await opencodePlugin.deliver!(ctx({ nodeId: 'oc1', sessionId: 'ses_abc123', cwd: '/tmp' }), {
        id: 'm1',
        text: 'привет'
      })
      expect(ok).toBe(true)
      expect(got.url).toBe('/session/ses_abc123/prompt_async?directory=%2Ftmp')
      expect(JSON.parse(got.body!)).toEqual({ parts: [{ type: 'text', text: 'привет' }] })
      // Сессии ещё нет — не умеем, пусть cnv вставит сам.
      expect(
        await opencodePlugin.deliver!(ctx({ nodeId: 'oc1', sessionId: id }), { id: 'm2', text: 'x' })
      ).toBe(false)
    } finally {
      server.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('конфиг через OPENCODE_CONFIG_CONTENT: MCP с токеном из env, файл инструкций, свой порт сервера', async () => {
    const dataDir = tmp('cnv-oc-')
    try {
      const line = await opencodePlugin.start(ctx({ command: 'opencode', dataDir, prompt: 'задача' }))
      const json = /OPENCODE_CONFIG_CONTENT='([^']+)'/.exec(line)?.[1]
      const config = JSON.parse(json!) as {
        mcp: { cnv: { url: string; headers: Record<string, string> } }
        instructions: string[]
      }
      expect(config.mcp.cnv.url).toBe(mcp.url)
      expect(config.mcp.cnv.headers.Authorization).toBe('Bearer {env:CNV_MCP_TOKEN}')
      expect(fs.readFileSync(config.instructions[0]!, 'utf8')).toBe('ты агент')
      // Порт сервера — чтобы письма шли в сессию по API, мимо поля ввода.
      expect(line).toMatch(/opencode --port \d+ --prompt 'задача'$/)
      expect(await opencodePlugin.resume(ctx({ dataDir, sessionId: 'ses_abc123' }))).toMatch(
        / --port \d+ --session ses_abc123$/
      )
      await expect(async () =>
        opencodePlugin.resume(ctx({ dataDir, sessionId: 'ses_x; ls' }))
      ).rejects.toThrow()
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('проверка своих плагинов', () => {
  const ok = {
    id: 'my-agent',
    label: 'Мой',
    command: 'my',
    start: () => '',
    resume: () => '',
    getSession: () => null
  }

  it('годный проходит', () => {
    expect(validatePlugin(ok)).toBe(ok)
  })

  it.each([
    [null, 'export default'],
    [{ ...ok, id: 'My Agent' }, 'id'],
    [{ ...ok, label: '' }, 'label'],
    [{ ...ok, getSession: undefined }, 'getSession'],
    [{ ...ok, hasSession: 'да' }, 'hasSession']
  ])('битый отклоняется с понятной причиной: %#', (value, reason) => {
    expect(() => validatePlugin(value)).toThrow(reason)
  })
})

describe('реестр', () => {
  it('встроенные + свои из папки; свой перекрывает встроенный; битый — в ошибках', async () => {
    const dir = tmp('cnv-agents-')
    try {
      fs.writeFileSync(
        path.join(dir, 'mine.mjs'),
        `export default { id: 'codex', label: 'Мой Codex', command: 'codex2', start: () => 'a', resume: () => 'b', getSession: () => null }`
      )
      fs.writeFileSync(path.join(dir, 'broken.mjs'), `export default { id: 'x' }`)
      const registry = new AgentRegistry(dir)
      const state = await registry.load()
      expect(state.plugins.map((p) => p.id)).toEqual(['claude', 'codex', 'opencode'])
      expect(state.plugins.find((p) => p.id === 'codex')).toMatchObject({
        label: 'Мой Codex',
        source: 'file'
      })
      expect(state.errors).toHaveLength(1)
      expect(state.errors[0]!.file).toMatch(/broken\.mjs$/)
      // Автору плагинов — типы и пример рядом.
      expect(fs.existsSync(path.join(dir, 'cnv-agent.d.ts'))).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'cnv-agent.d.ts'), 'utf8')).toContain('interface AgentPlugin')
      expect(fs.existsSync(path.join(dir, 'example.mjs.sample'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('запуск по контракту', () => {
  let dir: string
  beforeEach(() => {
    dir = tmp('cnv-launch-')
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function setup(plugin: AgentPlugin): { launcher: AgentLauncher; found: [string, string][] } {
    const registry = { get: (pid: string) => (pid === plugin.id ? plugin : undefined), dataDir: () => dir }
    const found: [string, string][] = []
    const launcher = new AgentLauncher({
      registry: registry as unknown as AgentRegistry,
      commandFor: () => undefined,
      mcp: () => null,
      onSession: (node, sid) => found.push([node, sid]),
      platform: 'linux'
    })
    return { launcher, found }
  }

  const fake = (over: Partial<AgentPlugin> = {}): AgentPlugin => ({
    id: 'fake',
    label: 'Фейк',
    command: 'fake',
    start: (c) => `start ${c.prompt ?? ''}`.trim(),
    resume: (c) => `resume ${c.sessionId}`,
    getSession: () => 'S1',
    ...over
  })

  it('без сессии — start, потом getSession, пока не найдёт', async () => {
    let calls = 0
    const { launcher, found } = setup(fake({ getSession: () => (++calls < 3 ? null : 'S1') }))
    const line = await launcher.commandLine({
      nodeId: 'a',
      agent: { plugin: 'fake', sessionId: '', prompt: 'p' }
    })
    expect(line).toBe('start p')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(found).toEqual([['a', 'S1']])
    expect(calls).toBe(3)
    expect(launcher.sessionOf('a')).toBe('S1')
  })

  it('живая сессия — resume, задание не нужно', async () => {
    const { launcher, found } = setup(fake({ hasSession: () => true }))
    const line = await launcher.commandLine({
      nodeId: 'a',
      agent: { plugin: 'fake', sessionId: 'S9', prompt: 'p' }
    })
    expect(line).toBe('resume S9')
    expect(found).toEqual([])
  })

  it('сессии больше нет — новый start', async () => {
    const { launcher } = setup(fake({ hasSession: () => false }))
    expect(await launcher.commandLine({ nodeId: 'a', agent: { plugin: 'fake', sessionId: 'S9' } })).toBe(
      'start'
    )
  })

  it('сессию держит другой живой агент — копия начинает свою', async () => {
    const { launcher } = setup(fake({ getSession: (q) => (q.taken.has('S1') ? 'S2' : 'S1') }))
    await launcher.commandLine({ nodeId: 'a', agent: { plugin: 'fake', sessionId: '' } })
    await vi.advanceTimersByTimeAsync(10)
    expect(launcher.sessionOf('a')).toBe('S1')
    expect(await launcher.commandLine({ nodeId: 'b', agent: { plugin: 'fake', sessionId: 'S1' } })).toBe(
      'start'
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(launcher.sessionOf('b')).toBe('S2')
  })

  it('остановленный терминал больше не ищет сессию', async () => {
    const getSession = vi.fn(() => null)
    const { launcher } = setup(fake({ getSession }))
    await launcher.commandLine({ nodeId: 'a', agent: { plugin: 'fake', sessionId: '' } })
    launcher.stopped('a')
    const before = getSession.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getSession.mock.calls.length).toBe(before)
  })

  it('нет плагина или он упал — понятное сообщение прямо в терминал', async () => {
    const { launcher } = setup(
      fake({
        start: () => {
          throw new Error('нет бинаря')
        }
      })
    )
    expect(await launcher.commandLine({ nodeId: 'a', agent: { plugin: 'ghost', sessionId: '' } })).toMatch(
      /^echo 'cnv: нет плагина агента «ghost»/
    )
    expect(await launcher.commandLine({ nodeId: 'a', agent: { plugin: 'fake', sessionId: '' } })).toMatch(
      /не запустился: нет бинаря/
    )
  })
})
