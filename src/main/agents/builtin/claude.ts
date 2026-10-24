import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentContext, AgentPlugin, AgentSessionInfo } from '@shared/agent-plugin'

/**
 * Claude Code. Единственный, кому id сессии можно задать заранее: `--session-id <uuid>`
 * при старте, `--resume <uuid>` потом. Поэтому `getSession` отвечает сразу. Живую сессию
 * отличаем по файлу на диске, а не по флагу в документе: агент мог так ничего и не
 * сказать, и тогда продолжать нечего.
 */

const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** Claude Code пишет сессию в `<home>/projects/<папка>/<id>.jsonl`; папку не вычисляем — ищем. */
export function claudeSessionExists(sessionId: string, home = claudeHome()): boolean {
  const projects = path.join(home, 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(projects)
  } catch {
    return false
  }
  return dirs.some((dir) => fs.existsSync(path.join(projects, dir, `${sessionId}.jsonl`)))
}

const SESSION_ID = /^[0-9a-f-]{36}$/i

/** Папка проекта Claude Code: путь, где всё, кроме латиницы и цифр, — дефисы. */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** Заголовок сессии: `ai-title`, а нет — первое сообщение человека. Читаем только начало файла. */
function sessionTitle(file: string): string | undefined {
  let head: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
  let firstUser: string | undefined
  for (const line of head.split('\n')) {
    let o: { type?: string; aiTitle?: string; summary?: string; message?: { content?: unknown } }
    try {
      o = JSON.parse(line) as typeof o
    } catch {
      continue
    }
    if (o.type === 'ai-title' && o.aiTitle) return o.aiTitle
    if (o.type === 'summary' && o.summary) return o.summary
    if (!firstUser && o.type === 'user') {
      const c = o.message?.content
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c.find((p: { type?: string }) => p.type === 'text') as { text?: string } | undefined)?.text
            : undefined
      if (text && !text.startsWith('<')) firstUser = text.replace(/\s+/g, ' ').slice(0, 120)
    }
  }
  return firstUser
}

export function listClaudeSessions(cwd: string, home = claudeHome(), limit = 30): AgentSessionInfo[] {
  const dir = path.join(home, 'projects', claudeProjectDir(cwd))
  let files: string[]
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => SESSION_ID.test(f.replace(/\.jsonl$/, '')) && f.endsWith('.jsonl'))
  } catch {
    return []
  }
  return files
    .map((f) => ({ file: path.join(dir, f), id: f.slice(0, -'.jsonl'.length) }))
    .map((s) => ({ ...s, updatedAt: fs.statSync(s.file).mtimeMs }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map(({ file, id, updatedAt }) => {
      const title = sessionTitle(file)
      return { id, updatedAt, ...(title ? { title } : {}) }
    })
}

function base(ctx: AgentContext): string[] {
  if (!SESSION_ID.test(ctx.sessionId)) throw new Error(`кривой id сессии: ${ctx.sessionId}`)
  const parts = [ctx.command]
  if (ctx.mcp) parts.push('--mcp-config', ctx.quote(ctx.mcp.configFile))
  // Кто ты и где — на каждом запуске, и при --resume тоже: имя и роль могли смениться.
  parts.push('--append-system-prompt', ctx.quote(ctx.systemPrompt))
  return parts
}

export const claudePlugin: AgentPlugin = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  description: 'Anthropic Claude Code: сессия задаётся заранее, продолжение — --resume',
  start(ctx) {
    const parts = [...base(ctx), '--session-id', ctx.sessionId]
    if (ctx.prompt) parts.push(ctx.quote(ctx.prompt))
    return parts.join(' ')
  },
  resume(ctx) {
    return [...base(ctx), '--resume', ctx.sessionId].join(' ')
  },
  getSession: (query) => query.sessionId,
  hasSession: (ctx) => claudeSessionExists(ctx.sessionId),
  listSessions: (ctx) => listClaudeSessions(ctx.cwd)
}
