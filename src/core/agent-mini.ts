import type { DocNode } from './document'
import { terminalSpec, withTerminalSpec } from './terminal'

/**
 * Свёрнутый агент — кружок со значком, прогрессом, именем и ролью. Когда с агентом
 * говорит координатор, человеку его терминал не нужен, а место на холсте — нужно.
 * Процесс при этом живёт как жил: сворачивается только вид.
 */

/** Размер свёрнутого: кружок и две строки подписи под ним. */
export const MINI_SIZE = { width: 140, height: 170 } as const

export const isCollapsed = (node: DocNode): boolean => terminalSpec(node)?.collapsed !== undefined

/** Свернуть: кружок встаёт в центр прежнего окна, прежний размер запоминается. */
export function collapseAgent(node: DocNode): DocNode {
  const spec = terminalSpec(node)
  if (!spec?.agent || spec.collapsed) return node
  return {
    ...node,
    x: Math.round(node.x + (node.width - MINI_SIZE.width) / 2),
    y: Math.round(node.y + (node.height - MINI_SIZE.height) / 2),
    width: MINI_SIZE.width,
    height: MINI_SIZE.height,
    extra: withTerminalSpec(node.extra, { collapsed: { width: node.width, height: node.height } })
  }
}

/** Развернуть: окно прежнего размера вокруг того места, где стоял кружок. */
export function expandAgent(node: DocNode): DocNode {
  const size = terminalSpec(node)?.collapsed
  if (!size) return node
  return {
    ...node,
    x: Math.round(node.x + (node.width - size.width) / 2),
    y: Math.round(node.y + (node.height - size.height) / 2),
    width: size.width,
    height: size.height,
    // undefined в спеке не попадает в JSON — пометка исчезает из файла.
    extra: withTerminalSpec(node.extra, { collapsed: undefined })
  }
}

/** Значок — первый символ (с emoji-модификаторами), пустая строка — снять. */
export function normalizeIcon(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)
  for (const { segment } of segments) return segment
  return ''
}
