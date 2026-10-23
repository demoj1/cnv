import { replaceNodes, type CanvasDoc, type DocNode } from './document'
import { uniqueName } from './names'
import { terminalSpec, withTerminalSpec, type TerminalSpec } from './terminal'

/**
 * Каждый терминал на холсте — со своим именем, каждый агент — со своей сессией Claude.
 * Копия, вставка, старый файл или чужая правка это ломают: у двух нод одно имя, два
 * агента продолжают один разговор. Здесь это чинится — первая нода в порядке документа
 * сохраняет своё, остальным выдаётся новое. Без изменений возвращается тот же `doc`.
 */
export function assignTerminalIdentities(
  doc: CanvasDoc,
  newSessionId: () => string,
  random: () => number = Math.random
): CanvasDoc {
  const terminals: { node: DocNode; spec: TerminalSpec }[] = []
  for (const node of doc.nodes) {
    const spec = terminalSpec(node)
    if (spec) terminals.push({ node, spec })
  }
  if (terminals.length === 0) return doc

  // Все уже занятые имена — новые не должны совпасть ни с одним из них.
  const names = new Set(terminals.flatMap(({ spec }) => (spec.name ? [spec.name] : [])))
  const sessions = new Set<string>()
  const fixes = new Map<string, TerminalSpec>()

  const seenNames = new Set<string>()
  for (const { node, spec } of terminals) {
    const fix: TerminalSpec = {}
    if (!spec.name || seenNames.has(spec.name)) {
      fix.name = uniqueName(names, random)
      names.add(fix.name)
    } else {
      seenNames.add(spec.name)
    }
    if (spec.agent) {
      if (sessions.has(spec.agent.sessionId)) fix.agent = { sessionId: newSessionId() }
      else sessions.add(spec.agent.sessionId)
    }
    if (fix.name || fix.agent) fixes.set(node.id, fix)
  }
  if (fixes.size === 0) return doc

  const replacements = new Map<string, DocNode>()
  for (const { node } of terminals) {
    const fix = fixes.get(node.id)
    if (fix) replacements.set(node.id, { ...node, extra: withTerminalSpec(node.extra, fix) })
  }
  return replaceNodes(doc, replacements)
}

/** Найти терминал по id ноды или по имени (без учёта регистра). */
export function findTerminal(doc: CanvasDoc, ref: string): DocNode | undefined {
  const lower = ref.trim().toLowerCase()
  return (
    doc.nodes.find((n) => n.id === ref && terminalSpec(n)) ??
    doc.nodes.find((n) => terminalSpec(n)?.name?.toLowerCase() === lower)
  )
}
