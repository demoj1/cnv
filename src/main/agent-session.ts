import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Агент — терминал, в котором сам запускается Claude Code с заранее известным id сессии.
 * Первый запуск — `--session-id <id>`, все следующие — `--resume <id>`: разговор
 * переживает перезапуск приложения. Различаем их по файлу сессии на диске, а не по флагу
 * в документе: агент мог так ничего и не сказать, и тогда продолжать нечего.
 */

export interface AgentLaunch {
  sessionId: string
  prompt?: string
}

const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** Claude Code пишет сессию в `<home>/projects/<папка>/<id>.jsonl`; папку не вычисляем — ищем. */
export function sessionExists(sessionId: string, home = claudeHome()): boolean {
  const projects = path.join(home, 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdirSync(projects)
  } catch {
    return false
  }
  return dirs.some((dir) => fs.existsSync(path.join(projects, dir, `${sessionId}.jsonl`)))
}

/** Кавычки для шелла, в котором агент запустится. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const SESSION_ID = /^[0-9a-f-]{36}$/i

/**
 * Строка, которую напечатать в шелл агента. `command` — из настроек (`claude` или путь),
 * `mcpConfig` — файл с нашим MCP: агенту не надо ничего настраивать, чтобы видеть холст.
 */
export function agentCommandLine(
  launch: AgentLaunch,
  options: { command: string; mcpConfig: string | null; resume: boolean; platform?: NodeJS.Platform }
): string {
  if (!SESSION_ID.test(launch.sessionId)) throw new Error(`кривой id сессии: ${launch.sessionId}`)
  const quote = (v: string): string => shellQuote(v, options.platform)
  const parts = [options.command]
  if (options.mcpConfig) parts.push('--mcp-config', quote(options.mcpConfig))
  if (options.resume) parts.push('--resume', launch.sessionId)
  else {
    parts.push('--session-id', launch.sessionId)
    if (launch.prompt) parts.push(quote(launch.prompt))
  }
  return parts.join(' ')
}
