import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client, type QueryConfig } from 'pg'
import type { SQLInputValue } from 'node:sqlite'
import mysql from 'mysql2/promise'
import { plural, type DbTable, type DbTablesResult } from '@shared/database'

/**
 * Базы данных для агентов: SQLite, PostgreSQL, MySQL/MariaDB по строке подключения.
 * Соединение живёт один вызов инструмента (или одну сборку карточки): держать нечего, утечь нечему.
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
    const own = cnvParams(url.searchParams)
    for (const key of ['table', 'write', 'multipleStatements']) url.searchParams.delete(key)
    const driver = scheme.startsWith('postgres') ? 'postgres' : 'mysql'
    if (driver === 'mysql') url.protocol = 'mysql:'
    const display = new URL(url)
    if (display.password) display.password = '***'
    return { driver, address: url.toString(), display: display.toString(), ...own }
  }
  const rest = withEnv(scheme ? raw.slice('sqlite:'.length).replace(/^\/\//, '') : raw, false)
  const [name = '', query = ''] = scheme ? rest.split('?', 2) : [rest]
  // Пробел в пути — %20: иначе строка подключения в тексте карточки оборвётся на нём.
  let file = name.replace(/%20/g, ' ')
  if (file === '~' || file.startsWith('~/')) file = path.join(os.homedir(), file.slice(1))
  if (!path.isAbsolute(file)) {
    if (!root) throw new Error(`путь ${file} относительный, а workspace не открыт`)
    file = path.resolve(root, file)
  }
  if (!fs.existsSync(file)) throw new Error(`нет файла SQLite ${file}`)
  return {
    driver: 'sqlite',
    address: file,
    display: `sqlite:${file}`,
    ...cnvParams(new URLSearchParams(query))
  }
}

/** Свои параметры cnv в строке подключения: `table` — одна таблица, `write=1` — запись. */
function cnvParams(params: URLSearchParams): Pick<DbTarget, 'table' | 'write'> {
  const table = params.get('table')
  return { write: truthy(params.get('write')), ...(table ? { table } : {}) }
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

function rowsResult(columns: string[], rows: Record<string, unknown>[], maxRows: number): DbResult {
  const cut = rows
    .slice(0, maxRows)
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])))
  return { columns, rows: cut, truncated: rows.length > maxRows }
}

/** Ответ на запрос, который строк не вернул (INSERT, UPDATE, DDL). */
const changed = (changes: number): DbResult => ({ columns: [], rows: [], truncated: false, changes })

/** Один запрос в открытом соединении. */
type Run = (sql: string, params?: unknown[], maxRows?: number) => Promise<DbResult>

interface Session {
  run(sql: string, params: unknown[], maxRows: number): Promise<DbResult>
  close(): Promise<void>
}

/** Только чтение: первое слово запроса — из читающих (сама база тоже открыта на чтение). */
function checkSql(target: DbTarget, sql: string): string {
  const text = sql.trim()
  if (!text) throw new Error('пустой запрос')
  const body = text.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\())*\s*/, '')
  if (!target.write && !READ_ONLY_SQL.test(body)) {
    throw new Error(
      'база подключена только на чтение — менять данные можно, если в строке подключения write=1'
    )
  }
  return text
}

async function open(target: DbTarget): Promise<Session> {
  switch (target.driver) {
    case 'sqlite': {
      // Лениво: node:sqlite нужен только тем, кто подключил SQLite.
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(target.address, { readOnly: !target.write, timeout: TIMEOUT_MS })
      return {
        async run(sql, params, maxRows) {
          const stmt = db.prepare(sql)
          // `$1, $2` — как в Postgres: агенту не помнить синтаксис каждой базы. Номерные
          // параметры SQLite связывает объектом по номерам, `?` — по порядку.
          const args = (
            /\$\d/.test(sql) ? [Object.fromEntries(params.map((v, k) => [k + 1, v]))] : params
          ) as SQLInputValue[]
          const columns = stmt.columns().map((c) => c.name)
          if (columns.length === 0) return changed(Number(stmt.run(...args).changes))
          const rows: Record<string, unknown>[] = []
          for (const row of stmt.iterate(...args)) {
            rows.push(row as Record<string, unknown>)
            if (rows.length > maxRows) break
          }
          return rowsResult(columns, rows, maxRows)
        },
        close: async () => db.close()
      }
    }
    case 'postgres': {
      const client = new Client({
        connectionString: target.address,
        connectionTimeoutMillis: 10_000,
        statement_timeout: TIMEOUT_MS
      })
      const close = (): Promise<void> => client.end().catch(() => undefined)
      await client.connect().catch(async (error: unknown) => {
        await close()
        throw error
      })
      return {
        async run(sql, params, maxRows) {
          // Только чтение — транзакцией на каждый запрос, а не SET SESSION: через пулер
          // (PgBouncer) настройка сессии утекла бы к чужим клиентам, а ошибка одного запроса
          // не валит следующие. extended — ровно один запрос: «SELECT 1; COMMIT; DELETE …»
          // не пройдёт.
          if (!target.write) await client.query('BEGIN READ ONLY')
          try {
            const res = await client.query({
              text: sql,
              values: params,
              queryMode: 'extended'
            } as QueryConfig)
            if (res.fields.length === 0) return changed(res.rowCount ?? 0)
            return rowsResult(
              res.fields.map((f) => f.name),
              res.rows,
              maxRows
            )
          } finally {
            if (!target.write) await client.query('ROLLBACK').catch(() => undefined)
          }
        },
        close
      }
    }
    case 'mysql': {
      const conn = await mysql.createConnection({
        uri: target.address,
        connectTimeout: 10_000,
        dateStrings: true,
        supportBigNumbers: true
      })
      const close = (): Promise<void> => conn.end().catch(() => undefined)
      if (!target.write) {
        await conn.query('SET SESSION TRANSACTION READ ONLY').catch(async (error: unknown) => {
          await close()
          throw error
        })
      }
      return {
        async run(sql, params, maxRows) {
          const [rows, fields] = await conn.query({ sql, timeout: TIMEOUT_MS }, params)
          if (!Array.isArray(rows)) return changed((rows as mysql.ResultSetHeader).affectedRows)
          return rowsResult(
            (fields ?? []).map((f) => f.name),
            rows as Record<string, unknown>[],
            maxRows
          )
        },
        close
      }
    }
  }
}

/** Открыть базу, сделать в одном соединении сколько угодно запросов и закрыть. */
export async function withDb<T>(target: DbTarget, fn: (run: Run) => Promise<T>): Promise<T> {
  const session = await open(target)
  try {
    return await fn(async (sql, params = [], maxRows = 200) =>
      session.run(checkSql(target, sql), params, maxRows)
    )
  } finally {
    await session.close()
  }
}

/** Выполнить один SQL-запрос. Только чтение — если в строке подключения нет `write=1`. */
export async function dbQuery(
  target: DbTarget,
  sql: string,
  params: unknown[] = [],
  maxRows = 200
): Promise<DbResult> {
  checkSql(target, sql)
  return withDb(target, (run) => run(sql, params, maxRows))
}

/** SQL схемы по базам: все таблицы и колонки одной таблицы (`args` — схема и имя). */
const SCHEMA: Record<
  DbDriver,
  { tables: string; columns: string; args(schema: string | null, name: string): unknown[] }
> = {
  sqlite: {
    tables:
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    columns: 'SELECT name, type, "notnull", pk FROM pragma_table_info(?)',
    args: (_schema, name) => [name]
  },
  postgres: {
    tables:
      "SELECT table_schema AS schema, table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
    columns:
      'SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_name = $1 AND ($2::text IS NULL OR table_schema = $2) ORDER BY table_schema, ordinal_position',
    args: (schema, name) => [name, schema]
  },
  mysql: {
    tables:
      'SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
    columns:
      'SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS `key` FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? ORDER BY ordinal_position',
    args: (schema, name) => [schema, name]
  }
}

/** Запрос схемы: колонки таблицы `table` (можно `schema.table`) или, без неё, все таблицы. */
function schemaSql(driver: DbDriver, table?: string): [string, unknown[]] {
  if (!table) return [SCHEMA[driver].tables, []]
  const [schema, name] = table.includes('.') ? (table.split('.', 2) as [string, string]) : [null, table]
  return [SCHEMA[driver].columns, SCHEMA[driver].args(schema, name)]
}

/** Таблицы базы (у подключённой таблицы — только она) или колонки одной таблицы. */
export async function dbSchema(target: DbTarget, table?: string): Promise<DbResult> {
  const [sql, params] = schemaSql(target.driver, table ?? target.table)
  return withDb({ ...target, write: false }, (run) => run(sql, params, 10_000))
}

/** Таблицы списком: имя (не из public — со схемой) и вид — table или view. */
async function listTables(run: Run, driver: DbDriver): Promise<DbTable[]> {
  const [sql, params] = schemaSql(driver)
  return (await run(sql, params, 10_000)).rows.map((t) => ({
    name: t.schema && t.schema !== 'public' ? `${String(t.schema)}.${String(t.name)}` : String(t.name),
    type: String(t.type).toLowerCase().replace('base ', '')
  }))
}

/** Путь без схемы — это SQLite: `shop.db` → `sqlite:shop.db`. */
const withScheme = (spec: string): string =>
  DB_SCHEME.test(spec.trim()) ? spec.trim() : `sqlite:${spec.trim()}`

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Для окна подключения: таблицы базы или причина, почему не подключилось. */
export async function dbTables(spec: string, root: string | null): Promise<DbTablesResult> {
  try {
    const target = parseDb(withScheme(spec), root)
    return { tables: await withDb({ ...target, write: false }, (run) => listTables(run, target.driver)) }
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** Сколько таблиц и строк показывать на карточке базы. */
const CARD_TABLES = 30
const CARD_ROWS = 5
const CARD_CELL = 40

/** Ячейка markdown-таблицы: одна строка, без `|`, не длиннее CARD_CELL. */
function mdCell(value: unknown): string {
  const text = (value === null || value === undefined ? 'NULL' : String(value)).replace(/\s+/g, ' ').trim()
  const cut = text.length > CARD_CELL ? `${text.slice(0, CARD_CELL - 1)}…` : text
  return cut.replace(/\\/g, '\\\\').replace(/\|/g, '\\|') || ' '
}

function mdTable(head: string[], rows: unknown[][]): string {
  return [
    `| ${head.map(mdCell).join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)
  ].join('\n')
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Заголовок карточки: имя базы (файла SQLite), у подключённой таблицы — и она. */
function dbTitle(target: DbTarget): string {
  const base =
    target.driver === 'sqlite'
      ? path.basename(target.address).replace(DB_FILE, '')
      : decodeURIComponent(new URL(target.address).pathname.slice(1)) || target.driver
  return target.table ? `${base} · ${target.table}` : base
}

/**
 * Таблица на карточке — раскрывающийся блок: в заголовке имя и вид, внутри колонки и первые
 * строки. Ошибка одной таблицы (нет прав) остаётся внутри её блока.
 */
async function tableBlock(run: Run, target: DbTarget, table: DbTable, open: boolean): Promise<string> {
  let note = table.type
  let body: string
  try {
    const columns = (await run(...schemaSql(target.driver, table.name), 10_000)).rows
    note += ` · ${plural(columns.length, 'колонка', 'колонки', 'колонок')}`
    const sql = `SELECT * FROM ${quoteTable(target.driver, table.name)} LIMIT ${CARD_ROWS + 1}`
    const { columns: head, rows, truncated } = await run(sql, [], CARD_ROWS)
    const sample =
      rows.length === 0
        ? '_строк нет_'
        : mdTable(
            head,
            rows.map((r) => head.map((c) => r[c]))
          )
    const more = truncated ? `\n\n_первые ${CARD_ROWS} строк_` : ''
    body = `${mdTable(
      ['Колонка', 'Тип'],
      columns.map((c) => [c.name, c.type])
    )}\n\n${sample}${more}`
  } catch (error) {
    body = `⚠ ${errorText(error)}`
  }
  const summary = `<summary><b>${escapeHtml(table.name)}</b> <small>${escapeHtml(note)}</small></summary>`
  return `<details${open ? ' open' : ''}>\n${summary}\n\n${body}\n\n</details>`
}

/**
 * Карточка базы для холста — markdown: заголовок, строка подключения (её же найдут агенты),
 * а под ней таблицы раскрывающимися блоками с колонками и первыми строками. Подключена одна
 * таблица — только она, раскрытая. Всё читается одним соединением. Не подключилось —
 * карточка всё равно, с причиной: строку можно поправить прямо в ней.
 */
export async function dbCard(spec: string, root: string | null): Promise<string> {
  const conn = withScheme(spec)
  const head = (title: string): string => `### 🛢 ${title}\n\n\`${conn}\``
  let target: DbTarget
  try {
    target = parseDb(conn, root)
  } catch (error) {
    return `${head('База данных')}\n\n⚠ ${errorText(error)}`
  }
  const title = dbTitle(target)
  try {
    return await withDb({ ...target, write: false }, async (run) => {
      const tables = target.table
        ? [{ name: target.table, type: 'table' }]
        : await listTables(run, target.driver)
      const blocks = [head(title), ...(tables.length === 0 ? ['_таблиц нет_'] : [])]
      for (const t of tables.slice(0, CARD_TABLES))
        blocks.push(await tableBlock(run, target, t, !!target.table))
      if (tables.length > CARD_TABLES) blocks.push(`_…и ещё ${tables.length - CARD_TABLES}_`)
      return blocks.join('\n\n')
    })
  } catch (error) {
    return `${head(title)}\n\n⚠ не подключилось: ${errorText(error)}`
  }
}
