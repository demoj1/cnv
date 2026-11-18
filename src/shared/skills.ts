/** Навык из каталога skills.sh. `name` — slug внутри источника, вместе они задают источник установки. */
export interface AgentSkill {
  id: string
  name: string
  source: string
  installs: number
}

/** Навыки из `.canvas` — внешние данные: берём только понятные записи и не даём списку расти без меры. */
export function normalizeAgentSkills(value: unknown): AgentSkill[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AgentSkill[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const skill = item as Record<string, unknown>
    if (
      typeof skill.name !== 'string' ||
      !skill.name.trim() ||
      typeof skill.source !== 'string' ||
      !skill.source.trim() ||
      typeof skill.installs !== 'number' ||
      !Number.isFinite(skill.installs)
    )
      continue
    const name = skill.name.trim().slice(0, 200)
    const source = skill.source.trim().slice(0, 300)
    const id = `${source}@${name}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, name, source, installs: Math.max(0, Math.round(skill.installs)) })
    if (out.length === 20) break
  }
  return out.length ? out : undefined
}

export function sameAgentSkills(
  a: readonly AgentSkill[] | undefined,
  b: readonly AgentSkill[] | undefined
): boolean {
  const ids = (skills: readonly AgentSkill[] | undefined): string =>
    (skills ?? [])
      .map((s) => s.id)
      .sort()
      .join('\n')
  return ids(a) === ids(b)
}
