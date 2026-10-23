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

/** Что агент должен знать о себе с первой реплики: имя, роль, и где искать команду. */
export function agentSystemPrompt(name: string | undefined, role: string | undefined): string {
  const who = name ? `Ты — агент «${name}»` : 'Ты — агент'
  return [
    `${who} на бесконечном холсте приложения cnv: твой терминал — карточка на холсте.`,
    role ? `Твоя роль: ${role}.` : 'Роль тебе пока не задали.',
    'У тебя есть MCP-сервер cnv: whoami — кто ты и с кем соединён, connections — соседи по связям с их ролями,',
    'agent_send — написать другому агенту, terminal_read — прочитать его ответ, create_node — карточки, страницы, новые агенты.',
    'Если тебе пишет другой агент — сообщение подписано его именем; отвечай ему через agent_send.'
  ].join(' ')
}

/**
 * Строка, которую напечатать в шелл агента. `command` — из настроек (`claude` или путь),
 * `mcpConfig` — файл с нашим MCP: агенту не надо ничего настраивать, чтобы видеть холст.
 */
export function agentCommandLine(
  launch: AgentLaunch,
  options: {
    command: string
    mcpConfig: string | null
    resume: boolean
    /** Кто ты и где: добавляется к системному промпту на каждом запуске, и при `--resume` тоже. */
    systemPrompt?: string
    platform?: NodeJS.Platform
  }
): string {
  if (!SESSION_ID.test(launch.sessionId)) throw new Error(`кривой id сессии: ${launch.sessionId}`)
  const quote = (v: string): string => shellQuote(v, options.platform)
  const parts = [options.command]
  if (options.mcpConfig) parts.push('--mcp-config', quote(options.mcpConfig))
  if (options.systemPrompt) parts.push('--append-system-prompt', quote(options.systemPrompt))
  if (options.resume) parts.push('--resume', launch.sessionId)
  else {
    parts.push('--session-id', launch.sessionId)
    if (launch.prompt) parts.push(quote(launch.prompt))
  }
  return parts.join(' ')
}
