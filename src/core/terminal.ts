import type { DocNode } from './document'

/**
 * Терминал живёт в обычной текстовой ноде, помеченной полем `x-cnv`. Своего типа в
 * JSON Canvas для него нет, а выдумывать — значит потерять совместимость: Obsidian
 * покажет такую ноду карточкой с подписью и ничего не сломает, а неизвестные поля он
 * сохраняет (это у нас проверено на живом редакторе).
 */
export interface TerminalSpec {
  /** Рабочая папка. Процесс перезапуск приложения не переживает, а папка — да. */
  cwd?: string
}

const KEY = 'x-cnv'

export function terminalSpec(node: DocNode): TerminalSpec | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  if (!own || typeof own !== 'object') return null
  const spec = (own as Record<string, unknown>).terminal
  if (!spec || typeof spec !== 'object') return null
  const cwd = (spec as Record<string, unknown>).cwd
  return typeof cwd === 'string' ? { cwd } : {}
}

export const isTerminal = (node: DocNode): boolean => terminalSpec(node) !== null

/** Пометка терминала в `extra`, поверх уже лежащих там чужих полей. */
export function withTerminalSpec(
  extra: Record<string, unknown>,
  spec: TerminalSpec
): Record<string, unknown> {
  const own = extra[KEY]
  const base = own && typeof own === 'object' ? (own as Record<string, unknown>) : {}
  return { ...extra, [KEY]: { ...base, terminal: { ...spec } } }
}

/** Текст карточки: то, что увидит Obsidian, открыв наш канвас. */
export const terminalPlaceholder = (shell: string): string => `\`терминал: ${shell}\``
