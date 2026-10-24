/**
 * Поиск по имени так, как зовут люди и агенты: «Прасковья» вместо «Бесстрашная Прасковья»,
 * «прасковя» с опечаткой, «бесстрашная». Точное имя — сразу; иначе — по целым словам, потом
 * по началу слов; если подходит ровно одна нода — она, если несколько — неоднозначно, если
 * ни одной — похожие имена для подсказки «может, ты про …».
 */

const norm = (s: string): string => s.trim().toLowerCase().replace(/ё/g, 'е')
const words = (s: string): string[] =>
  norm(s)
    .split(/[\s\-_«»"']+/)
    .filter(Boolean)

export interface NameMatch<T> {
  /** Однозначное совпадение. */
  hit?: T
  /** Подходят несколько — надо уточнить. */
  ambiguous: T[]
  /** Ничего не подошло, но эти похожи. */
  similar: T[]
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return row[b.length]!
}

export function matchName<T>(
  items: readonly T[],
  ref: string,
  nameOf: (item: T) => string | undefined
): NameMatch<T> {
  const wanted = norm(ref)
  const named = items.filter((i) => nameOf(i))
  if (!wanted) return { ambiguous: [], similar: [] }

  const pick = (found: T[]): NameMatch<T> | null =>
    found.length === 1
      ? { hit: found[0]!, ambiguous: [], similar: [] }
      : found.length > 1
        ? { ambiguous: found, similar: [] }
        : null

  const exact = named.filter((i) => norm(nameOf(i)!) === wanted)
  const byExact = pick(exact)
  if (byExact) return byExact

  const parts = words(ref)
  const byWords = pick(named.filter((i) => parts.every((p) => words(nameOf(i)!).includes(p))))
  if (byWords) return byWords

  const byPrefix = pick(
    named.filter((i) => parts.every((p) => words(nameOf(i)!).some((w) => w.startsWith(p))))
  )
  if (byPrefix) return byPrefix

  // Опечатки: каждое слово запроса близко к какому-то слову имени.
  const score = (i: T): number =>
    parts.reduce((sum, p) => sum + Math.min(...words(nameOf(i)!).map((w) => distance(p, w))), 0)
  const similar = named
    .map((i) => ({ i, d: score(i) }))
    .filter(({ d }) => d <= Math.max(2, Math.ceil(wanted.length / 4)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ i }) => i)
  return { ambiguous: [], similar }
}

/** Текст ошибки «не нашёл»: с вариантами, если они есть. */
export function notFoundMessage<T>(
  what: string,
  ref: string,
  match: NameMatch<T>,
  describe: (item: T) => string
): string {
  if (match.ambiguous.length > 0) {
    return `«${ref}» — неоднозначно, подходят: ${match.ambiguous.map(describe).join(', ')}. Уточни имя или дай id`
  }
  if (match.similar.length > 0) {
    return `нет ${what} «${ref}». Может, ты про ${match.similar.map(describe).join(' или ')}?`
  }
  return `нет ${what} «${ref}»`
}
