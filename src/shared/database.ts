/** Окно «База данных»: поля формы → строка подключения для карточки и агентов. */

export type DbKind = 'postgres' | 'mysql' | 'sqlite' | 'url'

export const DB_KINDS: readonly { id: DbKind; label: string; port?: string }[] = [
  { id: 'postgres', label: 'PostgreSQL', port: '5432' },
  { id: 'mysql', label: 'MySQL / MariaDB', port: '3306' },
  { id: 'sqlite', label: 'SQLite — файл' },
  { id: 'url', label: 'Своя строка подключения' }
]

export interface DbForm {
  kind: DbKind
  host: string
  port: string
  database: string
  user: string
  /** Пароль или `${ПЕРЕМЕННАЯ}` из окружения cnv. */
  password: string
  file: string
  url: string
  /** Пусто — вся база. */
  table: string
  write: boolean
}

export interface DbTable {
  name: string
  /** table или view. */
  type: string
}

export type DbTablesResult = { tables: DbTable[] } | { error: string }

/** `${ПЕРЕМЕННАЯ}` оставляем как есть — её подставит cnv; остальное кодируем для URL. */
const encode = (s: string): string =>
  s
    .split(/(\$\{\w+\})/)
    .map((part, i) => (i % 2 ? part : encodeURIComponent(part)))
    .join('')

/** Хватает ли полей, чтобы подключаться. */
export function dbFormReady(f: DbForm): boolean {
  if (f.kind === 'sqlite') return f.file.trim() !== ''
  if (f.kind === 'url') return f.url.trim() !== ''
  return f.host.trim() !== '' && f.database.trim() !== ''
}

/** Строка подключения из формы: `postgres://…`, `mysql://…`, `sqlite:путь` и `table=`, `write=1`. */
export function dbSpec(f: DbForm): string {
  let base: string
  switch (f.kind) {
    case 'sqlite':
      base = `sqlite:${f.file.trim().replace(/ /g, '%20')}`
      break
    case 'url':
      base = f.url.trim()
      break
    default: {
      const user = f.user.trim()
      const auth = user ? `${encode(user)}${f.password ? `:${encode(f.password)}` : ''}@` : ''
      const port = f.port.trim() ? `:${f.port.trim()}` : ''
      base = `${f.kind}://${auth}${f.host.trim()}${port}/${encode(f.database.trim())}`
    }
  }
  const params = [
    ...(f.table ? [`table=${f.table.replace(/[%&#+ ]/g, (c) => encodeURIComponent(c))}`] : []),
    ...(f.write ? ['write=1'] : [])
  ]
  return params.length > 0 ? `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}` : base
}

/** «1 таблица», «2 таблицы», «5 таблиц». */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
  return `${n} ${word}`
}
