import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, type QueryConfig } from 'pg'
import mysql from 'mysql2/promise'

/**
 * Базы данных для агентов: SQLite, PostgreSQL, MySQL/MariaDB по строке подключения.
 * Соединение — на один вызов: открыли, выполнили, закрыли; держать нечего и утечь нечему.
 */

export type DbDriver = 'sqlite' | 'postgres' | 'mysql'

export interface DbTarget {
  driver: DbDriver
  /** Файл SQLite или строка подключения без параметров cnv (table, write). */
  address: string
  /** Подключена одна таблица, а не вся база. */
  table?: string
  /** Можно менять данные; по умолчанию — только чтение. */
  write: boolean
  /** Для ответов агенту — без пароля. */
  display: string
}

export interface DbResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
  /** Сколько строк изменил запрос, который строк не вернул (INSERT, UPDATE, DDL). */
  changes?: number
}

export const DB_SCHEME = /^(postgres(?:ql)?|mysql|mariadb|sqlite):/i
export const DB_FILE = /\.(db|db3|sqlite3?)$/i
const URL_IN_TEXT = /\b(?:postgres(?:ql)?|mysql|mariadb|sqlite):[^\s`'"<>()]+/i
const FILE_IN_TEXT = /[^\s`'"<>()]+\.(?:db|db3|sqlite3?)(?![\w.])/i
/** Первое слово запроса, который только читает. */
const READ_ONLY_SQL = /^(select|with|show|explain|describe|desc|pragma|values|table)\b/i
const TIMEOUT_MS = 30_000

const truthy = (v: string | null): boolean => v !== null && /^(1|true|yes|on)?$/i.test(v)

/** `${PGPASS}` → значение из окружения cnv: пароль не лежит в файле холста. */
function withEnv(spec: string, encode: boolean): string {
  return spec.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) throw new Error(`в окружении cnv нет переменной ${name}`)
    return encode ? encodeURIComponent(value) : value
  })
}

/** Строка подключения из текста карточки: первый адрес базы или файл .db/.sqlite. */
export function dbSpecIn(text: string): string {
  return (text.match(URL_IN_TEXT) ?? text.match(FILE_IN_TEXT))?.[0] ?? text.trim()
}

/**
 * Строка подключения → цель. Понимает `postgres://…`, `mysql://…`, `mariadb://…`,
 * `sqlite:путь` и просто путь к файлу SQLite. Свои параметры: `table=<таблица>` — подключена
 * одна таблица, `write=1` — можно менять данные. Относительный путь — от workspace.
 */
export function parseDb(spec: string, root: string | null): DbTarget {
  const raw = spec.trim()
  const scheme = DB_SCHEME.exec(raw)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'sqlite') {
    const url = new URL(withEnv(raw, true))
    const table = url.searchParams.get('table') ?? undefined
    const write = truthy(url.searchParams.get('write'))
    for (const key of ['table', 'write', 'multipleStatements']) url.searchParams.delete(key)
    const driver: DbDriver = scheme.startsWith('postgres') ? 'postgres' : 'mysql'
    if (driver === 'mysql') url.protocol = 'mysql:'
    const display = new URL(url)
    if (display.password) display.password = '***'
    return {
      driver,
      address: url.toString(),
      write,
      display: display.toString(),
      ...(table ? { table } : {})
    }
  }
  let file = withEnv(scheme ? raw.slice('sqlite:'.length).replace(/^\/\//, '') : raw, false)
  let params = new URLSearchParams()
  const q = scheme ? file.indexOf('?') : -1
  if (q >= 0) {
    params = new URLSearchParams(file.slice(q + 1))
    file = file.slice(0, q)
  }
  if (file === '~' || file.startsWith('~/')) file = path.join(os.homedir(), file.slice(1))
  if (!path.isAbsolute(file)) {
    if (!root) throw new Error(`путь ${file} относительный, а workspace не открыт`)
    file = path.resolve(root, file)
  }
  if (!fs.existsSync(file)) throw new Error(`нет файла SQLite ${file}`)
  const table = params.get('table') ?? undefined
  return {
    driver: 'sqlite',
    address: file,
    write: truthy(params.get('write')),
    display: `sqlite:${file}`,
    ...(table ? { table } : {})
  }
}

/** Имя таблицы (можно со схемой: `public.orders`) — в кавычках диалекта. */
export function quoteTable(driver: DbDriver, table: string): string {
  const q = driver === 'mysql' ? '`' : '"'
  return table
    .split('.')
    .map((part) => q + part.replaceAll(q, q + q) + q)
    .join('.')
}

/** Значение ячейки — в JSON без потерь смысла: даты строкой, байты hex, bigint числом или строкой. */
function cell(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  return value
}

const cells = (row: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]))

function rowsResult(columns: string[], rows: Record<string, unknown>[], maxRows: number): DbResult {
  return { columns, rows: rows.slice(0, maxRows).map(cells), truncated: rows.length > maxRows }
}

/** Выполнить один SQL-запрос. Только чтение — если в строке подключения нет `write=1`. */
export async function dbQuery(
  target: DbTarget,
  sql: string,
  params: unknown[] = [],
  maxRows = 200
): Promise<DbResult> {
  const text = sql.trim()
  if (!text) throw new Error('пустой запрос')
  const body = text.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\())*\s*/, '')
  if (!target.write && !READ_ONLY_SQL.test(body)) {
    throw new Error(
      'база подключена только на чтение — менять данные можно, если в строке подключения write=1'
    )
  }
  switch (target.driver) {
    case 'sqlite':
      return sqlite(target, text, params, maxRows)
    case 'postgres':
      return postgres(target, text, params, maxRows)
    case 'mysql':
      return mysqlQuery(target, text, params, maxRows)
  }
}

async function sqlite(target: DbTarget, sql: string, params: unknown[], maxRows: number): Promise<DbResult> {
  // Лениво: node:sqlite нужен только тем, кто подключил SQLite.
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(target.address, { readOnly: !target.write, timeout: TIMEOUT_MS })
  try {
    const stmt = db.prepare(sql)
    const args = params as (string | number | null)[]
    const columns = stmt.columns().map((c) => c.name)
    if (columns.length === 0) {
      return { columns, rows: [], truncated: false, changes: Number(stmt.run(...args).changes) }
    }
    const rows: Record<string, unknown>[] = []
    for (const row of stmt.iterate(...args)) {
      rows.push(row as Record<string, unknown>)
      if (rows.length > maxRows) break
    }
    return rowsResult(columns, rows, maxRows)
  } finally {
    db.close()
  }
}

async function postgres(
  target: DbTarget,
  sql: string,
  params: unknown[],
  maxRows: number
): Promise<DbResult> {
  const client = new Client({
    connectionString: target.address,
    connectionTimeoutMillis: 10_000,
    statement_timeout: TIMEOUT_MS
  })
  await client.connect()
  try {
    if (!target.write) await client.query('BEGIN READ ONLY')
    // extended — ровно один запрос: «SELECT 1; COMMIT; DELETE …» мимо READ ONLY не пройдёт.
    const res = await client.query({ text: sql, values: params, queryMode: 'extended' } as QueryConfig)
    if (res.fields.length === 0)
      return { columns: [], rows: [], truncated: false, changes: res.rowCount ?? 0 }
    return rowsResult(
      res.fields.map((f) => f.name),
      res.rows,
      maxRows
    )
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function mysqlQuery(
  target: DbTarget,
  sql: string,
  params: unknown[],
  maxRows: number
): Promise<DbResult> {
  const conn = await mysql.createConnection({
    uri: target.address,
    connectTimeout: 10_000,
    dateStrings: true,
    supportBigNumbers: true
  })
  try {
    if (!target.write) await conn.query('SET SESSION TRANSACTION READ ONLY')
    const [rows, fields] = await conn.query({ sql, timeout: TIMEOUT_MS }, params)
    if (!Array.isArray(rows)) {
      return {
        columns: [],
        rows: [],
        truncated: false,
        changes: (rows as mysql.ResultSetHeader).affectedRows
      }
    }
    return rowsResult(
      (fields ?? []).map((f) => f.name),
      rows as Record<string, unknown>[],
      maxRows
    )
  } finally {
    await conn.end().catch(() => undefined)
  }
}

/** Таблицы базы (у подключённой таблицы — только она) или колонки одной таблицы. */
export async function dbSchema(target: DbTarget, table?: string): Promise<DbResult> {
  const one = table ?? target.table
  const [schema, name] = one?.includes('.') ? (one.split('.', 2) as [string, string]) : [null, one]
  const read = { ...target, write: false }
  switch (target.driver) {
    case 'sqlite':
      return name
        ? dbQuery(read, 'SELECT name, type, "notnull", pk FROM pragma_table_info(?)', [name], 10_000)
        : dbQuery(
            read,
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            [],
            10_000
          )
    case 'postgres':
      return name
        ? dbQuery(
            read,
            'SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2) ORDER BY table_schema, ordinal_position',
            [name, schema],
            10_000
          )
        : dbQuery(
            read,
            "SELECT table_schema AS schema, table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
            [],
            10_000
          )
    case 'mysql':
      return name
        ? dbQuery(
            read,
            'SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS `key` FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? ORDER BY ordinal_position',
            [schema, name],
            10_000
          )
        : dbQuery(
            read,
            'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
            [],
            10_000
          )
  }
}
