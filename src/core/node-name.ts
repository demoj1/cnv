import type { DocNode } from './document'
import { terminalSpec, withTerminalSpec } from './terminal'

/**
 * Имена есть у нод, с которыми агенты общаются: терминалы, агенты и веб-страницы.
 * У терминала имя лежит в его спеке, у страницы — прямо в `x-cnv.name`.
 */

const KEY = 'x-cnv'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'

export const isNameable = (node: DocNode): boolean => node.type === 'link' || terminalSpec(node) !== null

export function nodeName(node: DocNode): string | undefined {
  if (node.type === 'link') {
    const own = node.extra[KEY]
    return isRecord(own) && typeof own.name === 'string' ? own.name : undefined
  }
  return terminalSpec(node)?.name
}

/** Нода с новым именем; неименуемая возвращается как есть. */
export function withNodeName(node: DocNode, name: string): DocNode {
  if (node.type === 'link') {
    const own = node.extra[KEY]
    return { ...node, extra: { ...node.extra, [KEY]: { ...(isRecord(own) ? own : {}), name } } }
  }
  if (!terminalSpec(node)) return node
  return { ...node, extra: withTerminalSpec(node.extra, { name }) }
}
