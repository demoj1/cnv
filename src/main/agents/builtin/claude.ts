import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentContext, AgentPlugin } from '@shared/agent-plugin'

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
  hasSession: (ctx) => claudeSessionExists(ctx.sessionId)
}
