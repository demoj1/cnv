import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentPlugin, AgentPluginInfo, AgentPluginsState } from '@shared/agent-plugin'
import pluginTypes from '@shared/agent-plugin?raw'
import { claudePlugin } from './builtin/claude'
import { codexPlugin } from './builtin/codex'
import { opencodePlugin } from './builtin/opencode'

export const BUILTIN_PLUGINS: readonly AgentPlugin[] = [claudePlugin, codexPlugin, opencodePlugin]

/** Агент старых канвасов и агент по умолчанию. */
export const DEFAULT_AGENT = 'claude'

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Что пришло из чужого файла — ещё не плагин: проверяем всё, что cnv будет вызывать. */
export function validatePlugin(value: unknown): AgentPlugin {
  if (!value || typeof value !== 'object') throw new Error('нет export default с объектом плагина')
  const p = value as Record<string, unknown>
  if (typeof p.id !== 'string' || !ID.test(p.id)) {
    throw new Error('id — латиница в нижнем регистре, цифры и дефис, до 40 знаков')
  }
  for (const key of ['label', 'command'] as const) {
    if (typeof p[key] !== 'string' || !(p[key] as string).trim()) throw new Error(`нет строки ${key}`)
  }
  for (const key of ['start', 'resume', 'getSession'] as const) {
    if (typeof p[key] !== 'function') throw new Error(`нет функции ${key}`)
  }
  if (p.hasSession !== undefined && typeof p.hasSession !== 'function') {
    throw new Error('hasSession должен быть функцией')
  }
  if (p.description !== undefined && typeof p.description !== 'string') {
    throw new Error('description должен быть строкой')
  }
  return value as AgentPlugin
}

const EXAMPLE = `// Свой агент для cnv. Переименуй в *.mjs — и он появится в настройках «Агенты».
// Контракт с комментариями — в cnv-agent.d.ts рядом.
// @ts-check

/** @type {import('./cnv-agent').AgentPlugin} */
export default {
  id: 'my-agent',
  label: 'Мой агент',
  command: 'my-agent',
  description: 'пример: агент, который принимает id сессии заранее',

  // Новый агент. ctx.sessionId — свежий UUID, его можно отдать агенту.
  start: (ctx) => [ctx.command, '--session', ctx.sessionId, '--system', ctx.quote(ctx.systemPrompt)].join(' '),

  // Продолжить сохранённую сессию ctx.sessionId.
  resume: (ctx) => [ctx.command, '--resume', ctx.sessionId].join(' '),

  // id сессии, которую начал start. null — «ещё нет», cnv спросит снова.
  // Агент сам выбирает id? Ищи его файл по ctx.cwd, не раньше query.startedAt, мимо query.taken.
  getSession: (query) => query.sessionId,

  // Необязательно: жива ли сессия. Нет — cnv запустит агента заново через start.
  hasSession: () => true
}
`

interface Loaded {
  plugin: AgentPlugin
  info: AgentPluginInfo
}

/**
 * Встроенные агенты и свои из папки `<userData>/agents/*.mjs`. Свой с тем же id перекрывает
 * встроенный — так можно поправить, как запускается Claude, не дожидаясь релиза.
 */
export class AgentRegistry {
  private loaded = new Map<string, Loaded>()
  private errors: { file: string; error: string }[] = []

  constructor(readonly dir: string) {}

  async load(): Promise<AgentPluginsState> {
    const next = new Map<string, Loaded>()
    for (const plugin of BUILTIN_PLUGINS) next.set(plugin.id, { plugin, info: infoOf(plugin, 'builtin') })
    const errors: { file: string; error: string }[] = []

    this.prepareDir()
    let files: string[] = []
    try {
      files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.mjs'))
        .sort()
    } catch {
      // Папки нет и создать не вышло — значит, только встроенные.
    }
    for (const name of files) {
      const file = path.join(this.dir, name)
      try {
        // ?v= — чтобы «перечитать» видел правки: import кеширует модуль по адресу.
        const mod = (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?v=${Date.now()}`)) as {
          default?: unknown
        }
        const plugin = validatePlugin(mod.default)
        next.set(plugin.id, { plugin, info: infoOf(plugin, 'file', file) })
      } catch (error) {
        errors.push({ file, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.loaded = next
    this.errors = errors
    return this.state()
  }

  state(): AgentPluginsState {
    return { plugins: [...this.loaded.values()].map((l) => l.info), errors: this.errors, dir: this.dir }
  }

  get(id: string): AgentPlugin | undefined {
    return this.loaded.get(id)?.plugin
  }

  /** Своя папка плагина для временных файлов: промпт, конфиг. */
  dataDir(id: string): string {
    const dir = path.join(this.dir, '.data', id)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Типы и пример лежат рядом с плагинами: их пишут в редакторе, без сборки. */
  private prepareDir(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(path.join(this.dir, 'cnv-agent.d.ts'), pluginTypes, 'utf8')
      const example = path.join(this.dir, 'example.mjs.sample')
      if (!fs.existsSync(example)) fs.writeFileSync(example, EXAMPLE, 'utf8')
    } catch {
      // Только для удобства автора плагинов — без них cnv работает.
    }
  }
}

function infoOf(plugin: AgentPlugin, source: AgentPluginInfo['source'], file?: string): AgentPluginInfo {
  return {
    id: plugin.id,
    label: plugin.label,
    command: plugin.command,
    ...(plugin.description ? { description: plugin.description } : {}),
    source,
    ...(file ? { file } : {})
  }
}
