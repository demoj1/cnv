import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMethod, AgentMethods, AgentNode } from '@shared/agent'
import { COMMANDS } from '@shared/commands'
import { dbCard, dbQuery, dbSchema, dbSpecIn, parseDb, quoteTable } from '../../src/main/database'
import { McpHandler, type ToolResult } from '../../src/main/mcp/protocol'
import { buildTools, serverInfo, type ToolDeps } from '../../src/main/mcp/tools'

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-db-'))
  file = path.join(dir, 'shop.db')
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT NOT NULL, qty INTEGER, payload BLOB);
    INSERT INTO orders (item, qty, payload) VALUES ('чай', 2, x'ff00'), ('кофе', 1, NULL), ('сахар', 5, NULL);
    CREATE VIEW big AS SELECT * FROM orders WHERE qty > 1;
  `)
  db.close()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.CNV_TEST_PASS
})

describe('строка подключения', () => {
  it('postgres: свои параметры снимает, пароль берёт из окружения и прячет', () => {
    process.env.CNV_TEST_PASS = 'p@ss/word'
    const t = parseDb(
      'postgresql://app:${CNV_TEST_PASS}@db.local:5432/shop?sslmode=require&table=public.orders&write=1',
      null
    )
    expect(t).toMatchObject({ driver: 'postgres', table: 'public.orders', write: true })
    expect(t.address).toBe('postgresql://app:p%40ss%2Fword@db.local:5432/shop?sslmode=require')
    expect(t.display).toBe('postgresql://app:***@db.local:5432/shop?sslmode=require')
  })

  it('mysql и mariadb — один драйвер; по умолчанию только чтение; лишние запросы за раз не пускаем', () => {
    const t = parseDb('mariadb://root@127.0.0.1/shop?multipleStatements=true', null)
    expect(t).toMatchObject({ driver: 'mysql', write: false, address: 'mysql://root@127.0.0.1/shop' })
    expect(t.table).toBeUndefined()
  })

  it('нет переменной окружения — понятная ошибка', () => {
    expect(() => parseDb('postgres://app:${CNV_TEST_PASS}@h/db', null)).toThrow('CNV_TEST_PASS')
  })

  it('sqlite: абсолютный путь, путь от workspace, просто файл; файла нет — ошибка', () => {
    expect(parseDb(`sqlite://${file}?table=orders`, null)).toMatchObject({
      driver: 'sqlite',
      address: file,
      table: 'orders',
      write: false
    })
    expect(parseDb('sqlite:shop.db?write=1', dir)).toMatchObject({ address: file, write: true })
    expect(parseDb('shop.db', dir)).toMatchObject({ driver: 'sqlite', address: file })
    expect(() => parseDb('nope.db', dir)).toThrow('нет файла SQLite')
    expect(() => parseDb('shop.db', null)).toThrow('workspace')
  })

  it('из текста карточки достаёт адрес базы или файл', () => {
    expect(dbSpecIn('**Продажи**\n\n`postgres://ro@db/sales?table=orders`\n')).toBe(
      'postgres://ro@db/sales?table=orders'
    )
    expect(dbSpecIn('База: data/shop.sqlite — заказы')).toBe('data/shop.sqlite')
  })

  it('имя таблицы — в кавычках диалекта, со схемой', () => {
    expect(quoteTable('postgres', 'public.odd "t"')).toBe('"public"."odd ""t"""')
    expect(quoteTable('mysql', 'shop.o`rders')).toBe('`shop`.`o``rders`')
  })
})

describe('SQLite', () => {
  it('схема: таблицы и представления, колонки таблицы', async () => {
    const t = parseDb(file, null)
    expect((await dbSchema(t)).rows).toEqual([
      { name: 'big', type: 'view' },
      { name: 'orders', type: 'table' }
    ])
    expect((await dbSchema(t, 'orders')).rows.map((r) => r.name)).toEqual(['id', 'item', 'qty', 'payload'])
    // Подключена одна таблица — схема сразу о ней.
    expect((await dbSchema(parseDb(`sqlite:${file}?table=orders`, null))).columns).toContain('notnull')
  })

  it('запрос с параметрами, байты — hex, лишние строки отрезаются', async () => {
    const t = parseDb(file, null)
    expect(await dbQuery(t, 'SELECT item, payload FROM orders WHERE qty >= ? ORDER BY id', [2])).toEqual({
      columns: ['item', 'payload'],
      rows: [
        { item: 'чай', payload: '0xff00' },
        { item: 'сахар', payload: null }
      ],
      truncated: false
    })
    const cut = await dbQuery(t, '-- все\nSELECT id FROM orders ORDER BY id', [], 2)
    expect(cut).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], truncated: true })
  })

  it('по умолчанию только чтение — и словом запроса, и самой базой', async () => {
    const t = parseDb(file, null)
    await expect(dbQuery(t, "INSERT INTO orders (item) VALUES ('x')")).rejects.toThrow('только на чтение')
    await expect(
      dbQuery(t, "WITH n AS (SELECT 'x') INSERT INTO orders (item) SELECT * FROM n")
    ).rejects.toThrow(/readonly/i)
  })

  it('write=1 — можно менять данные', async () => {
    const t = parseDb(`sqlite:${file}?write=1`, null)
    expect(await dbQuery(t, 'UPDATE orders SET qty = qty + 1 WHERE qty < ?', [3])).toMatchObject({
      changes: 2,
      rows: []
    })
    expect((await dbQuery(t, 'SELECT sum(qty) AS total FROM orders')).rows).toEqual([{ total: 10 }])
  })
})

describe('инструменты db_schema и db_query', () => {
  const node = (n: Partial<AgentNode> & Pick<AgentNode, 'id' | 'kind'>): AgentNode => ({
    desktop: 1,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    ...n
  })

  function setup(nodes: AgentNode[]): McpHandler {
    const answers: Partial<{
      [M in AgentMethod]: (p: AgentMethods[M]['params']) => AgentMethods[M]['result']
    }> = {
      getCanvas: () => ({
        nodes,
        edges: [],
        selection: [],
        edgeSelection: [],
        activeNodeId: null,
        viewport: { x: 0, y: 0, width: 1, height: 1, zoom: 1 },
        activeDesktop: 1,
        dirty: false,
        canUndo: false,
        canRedo: false
      }),
      getNodes: ({ ids }) => nodes.filter((n) => ids.includes(n.id))
    }
    const deps: ToolDeps = {
      call: async (method, params) => {
        const answer = answers[method] as ((p: unknown) => unknown) | undefined
        if (!answer) throw new Error(`не ждали ${method}`)
        return answer(params) as never
      },
      context: () => ({ appVersion: '9', canvasFile: null, workspaceRoot: dir, mcpUrl: 'http://x' }),
      terminals: { list: () => [], isRunning: () => false, write: () => {} },
      importFile: async (abs) => ({ relPath: abs }),
      screenshot: async () => null,
      web: { evaluate: async () => ({}), capture: async () => null },
      commands: COMMANDS,
      sleep: async () => {}
    }
    return new McpHandler(serverInfo(deps), buildTools(deps))
  }

  async function call(handler: McpHandler, name: string, args: unknown): Promise<ToolResult> {
    const res = (await handler.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { nodeId: 'me' }
    )) as { result: ToolResult }
    return res.result
  }
  const json = (r: ToolResult): Record<string, unknown> =>
    JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>

  it('карточка со строкой подключения: без sql — строки подключённой таблицы', async () => {
    const handler = setup([
      node({ id: 'c', kind: 'text', name: 'Склад', text: 'sqlite:shop.db?table=orders' })
    ])
    const out = json(await call(handler, 'db_query', { db: 'Склад', max_rows: 2 }))
    expect(out).toMatchObject({
      db: `sqlite:${file}`,
      columns: ['id', 'item', 'qty', 'payload'],
      truncated: true
    })
    expect(out.rows).toHaveLength(2)
    expect(json(await call(handler, 'db_schema', { db: 'c' })).rows).toHaveLength(4)
  })

  it('файл .db на холсте и прямой путь; не база — ошибка', async () => {
    const handler = setup([
      node({ id: 'f', kind: 'file', file: 'shop.db' }),
      node({ id: 't', kind: 'text', name: 'Заметка', text: 'просто текст' })
    ])
    expect(
      json(await call(handler, 'db_query', { db: 'f', sql: 'SELECT count(*) AS n FROM orders' })).rows
    ).toEqual([{ n: 3 }])
    expect(json(await call(handler, 'db_schema', { db: file })).rows).toHaveLength(2)
    const bad = await call(handler, 'db_query', { db: 'Заметка', sql: 'SELECT 1' })
    expect(bad.isError).toBe(true)
    const noSql = await call(handler, 'db_query', { db: 'f' })
    expect(noSql.isError).toBe(true)
  })
})

describe('карточка базы на холсте', () => {
  it('вся база: заголовок, строка подключения и таблицы — строку найдут агенты', async () => {
    const text = await dbCard(`sqlite:${file}`, null)
    expect(text).toBe(
      [
        '### 🛢 shop',
        '',
        `\`sqlite:${file}\``,
        '',
        '| Таблица | Тип |',
        '|---|---|',
        '| big | view |',
        '| orders | table |'
      ].join('\n')
    )
    expect(parseDb(dbSpecIn(text), null).address).toBe(file)
  })

  it('одна таблица: колонки и первые строки; путь без схемы — sqlite:', async () => {
    // В окне путь можно ввести без схемы — на карточку он ляжет как sqlite:.
    const card = await dbCard('shop.db?table=orders', dir)
    expect(card).toContain('`sqlite:shop.db?table=orders`')
    expect(card).toContain('### 🛢 shop · orders')
    expect(card).toContain('| Колонка | Тип |\n|---|---|\n| id | INTEGER |')
    expect(card).toContain('| id | item | qty | payload |\n|---|---|---|---|\n| 1 | чай | 2 | 0xff00 |')
    expect(parseDb(dbSpecIn(card), dir)).toMatchObject({ address: file, table: 'orders' })
  })

  it('не подключилось — карточка с причиной', async () => {
    const text = await dbCard('postgres://u@127.0.0.1:1/x', null)
    expect(text).toMatch(/^### 🛢 x\n\n`postgres:\/\/u@127\.0\.0\.1:1\/x`\n\n⚠ не подключилось: /)
  })
})
