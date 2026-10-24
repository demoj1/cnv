import { replaceNodes, type CanvasDoc, type DocNode } from './document'
import { uniqueName } from './names'
import { isNameable, nodeName, withNodeName } from './node-name'
import { terminalSpec, withTerminalSpec } from './terminal'
import { matchName, type NameMatch } from './name-match'

/**
 * У каждого терминала, агента и веб-страницы на холсте — своё имя, у каждого агента —
 * своя сессия. Копия, вставка, старый файл или чужая правка это ломают: у двух нод одно
 * имя, два агента продолжают один разговор. Здесь это чинится — первая нода в порядке
 * документа сохраняет своё, остальным выдаётся новое имя, а сессия сбрасывается: агент
 * начнёт свою. Без изменений возвращается тот же `doc`.
 */
export function assignIdentities(doc: CanvasDoc, random: () => number = Math.random): CanvasDoc {
  const named = doc.nodes.filter(isNameable)
  if (named.length === 0) return doc

  // Все уже занятые имена — новые не должны совпасть ни с одним из них.
  const names = new Set(named.flatMap((n) => nodeName(n) ?? []))
  const seenNames = new Set<string>()
  const sessions = new Set<string>()
  const replacements = new Map<string, DocNode>()

  for (const node of named) {
    let next = node
    const name = nodeName(node)
    // Страница без пометки — чужая (из Obsidian): пока не назвали руками, остаётся без имени.
    const wantsName = node.type !== 'link' || name !== undefined
    if (wantsName && (!name || seenNames.has(name))) {
      const fresh = uniqueName(names, random)
      names.add(fresh)
      next = withNodeName(next, fresh)
    } else if (name) {
      seenNames.add(name)
    }
    const agent = terminalSpec(node)?.agent
    if (agent?.sessionId) {
      if (sessions.has(agent.sessionId)) {
        next = { ...next, extra: withTerminalSpec(next.extra, { agent: { ...agent, sessionId: '' } }) }
      } else {
        sessions.add(agent.sessionId)
      }
    }
    if (next !== node) replacements.set(node.id, next)
  }
  return replacements.size === 0 ? doc : replaceNodes(doc, replacements)
}

/**
 * Именованная нода по id или по имени (без учёта регистра, по части имени, с опечаткой —
 * см. `matchName`), с фильтром по виду. Неоднозначно или не нашлось — `match` объяснит.
 */
export function lookupNamed(
  doc: CanvasDoc,
  ref: string,
  accept: (node: DocNode) => boolean = isNameable
): { node?: DocNode; match: NameMatch<DocNode> } {
  const byId = doc.nodes.find((n) => n.id === ref && accept(n))
  if (byId) return { node: byId, match: { hit: byId, ambiguous: [], similar: [] } }
  const match = matchName(doc.nodes.filter(accept), ref, nodeName)
  return match.hit ? { node: match.hit, match } : { match }
}

export function findNamed(
  doc: CanvasDoc,
  ref: string,
  accept: (node: DocNode) => boolean = isNameable
): DocNode | undefined {
  return lookupNamed(doc, ref, accept).node
}

const isTerminalNode = (n: DocNode): boolean => terminalSpec(n) !== null
const isWebNode = (n: DocNode): boolean => n.type === 'link'

export const findTerminal = (doc: CanvasDoc, ref: string): DocNode | undefined =>
  findNamed(doc, ref, isTerminalNode)

export const findWeb = (doc: CanvasDoc, ref: string): DocNode | undefined => findNamed(doc, ref, isWebNode)

export const lookupTerminal = (doc: CanvasDoc, ref: string): ReturnType<typeof lookupNamed> =>
  lookupNamed(doc, ref, isTerminalNode)

export const lookupWeb = (doc: CanvasDoc, ref: string): ReturnType<typeof lookupNamed> =>
  lookupNamed(doc, ref, isWebNode)

/** Как назвать ноду в подсказке: «Бесстрашная Прасковья» (id abc…). */
export const describeNamed = (n: DocNode): string => `«${nodeName(n) ?? n.id}» (id ${n.id})`
