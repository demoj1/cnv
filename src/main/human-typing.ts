/* eslint-disable no-control-regex -- здесь и разбираем управляющие коды терминала */
/**
 * Что человек набирает в терминале — по нажатиям, если экран агента не разобрать: есть
 * ли недописанная строка (набрал и не отправил) и когда он печатал последний раз.
 */
const typing = new Map<string, { draft: boolean; at: number }>()

/** Управляющие последовательности (стрелки, фокус, мышь, рамки вставки) — не текст. */
const CONTROL_SEQ = /\x1b\[[0-9;<?]*[ -/]*[@-~]|\x1bO.|\x1b./g

export function noteHumanInput(nodeId: string, data: string): void {
  const prev = typing.get(nodeId) ?? { draft: false, at: 0 }
  const plain = data.replace(CONTROL_SEQ, '')
  // Enter отправил, Ctrl+C и Ctrl+U стёрли — строка снова пуста.
  const cleared = /[\r\x03\x15]/.test(plain)
  const typed = /[^\x00-\x1f\x7f]/.test(plain.split(/[\r\x03\x15]/).pop() ?? '')
  typing.set(nodeId, { draft: typed || (!cleared && prev.draft), at: Date.now() })
}

/** Черновик по нажатиям: набрано и не отправлено; `idleMs` — сколько человек не печатал. */
export function humanTyping(nodeId: string): { draft: boolean; idleMs: number } {
  const t = typing.get(nodeId)
  return t ? { draft: t.draft, idleMs: Date.now() - t.at } : { draft: false, idleMs: Infinity }
}

export function forgetTyping(nodeId: string): void {
  typing.delete(nodeId)
}
