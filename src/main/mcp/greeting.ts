/**
 * Что сказать агенту, когда cnv поднялся заново: он переподключился и продолжает разговор,
 * но не знает, что холст перезапускали, — а если вышла новая версия, то и что в ней нового.
 */

/** Раздел ченджлога этой версии: от «## <версия>» до следующего «## ». */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`## ${version}`))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
  return body || null
}

export function greetingText(version: string, previous: string | null, changelog: string): string {
  const head = `[cnv перезапущен — версия ${version}. Ты переподключён к холсту, разговор продолжается; письма, отправленные до перезапуска, в почте (inbox).]`
  if (!previous || previous === version) return head
  const notes = changelogSection(changelog, version)
  return notes ? `${head}\nОбновление ${previous} → ${version}, что нового:\n${notes}` : head
}
