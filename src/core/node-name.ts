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

export function nodeRole(node: DocNode): string | undefined {
  if (node.type === 'link') {
    const own = node.extra[KEY]
    return isRecord(own) && typeof own.role === 'string' && own.role ? own.role : undefined
  }
  return terminalSpec(node)?.role
}

/** Нода с новой ролью; пустая строка роль снимает. */
export function withNodeRole(node: DocNode, role: string): DocNode {
  if (node.type === 'link') {
    const own = node.extra[KEY]
    const base = { ...(isRecord(own) ? own : {}) }
    if (role) base.role = role
    else delete base.role
    return { ...node, extra: { ...node.extra, [KEY]: base } }
  }
  if (!terminalSpec(node)) return node
  // undefined в спеке не попадает в JSON — роль исчезает из файла.
  return { ...node, extra: withTerminalSpec(node.extra, { role: role || undefined }) }
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
