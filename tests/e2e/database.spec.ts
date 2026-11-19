import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

/** Кнопка «База данных» слева: окно подключения → карточка с раскрывающимися таблицами. */

let h: Harness
let server: { url: string; token: string }

test.beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cnv-ws-'))
  const db = new DatabaseSync(path.join(dir, 'shop.db'))
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, qty INTEGER);
    INSERT INTO orders (item, qty) VALUES ('чай', 2), ('кофе', 1);
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO clients (name) VALUES ('Анна');
  `)
  db.close()
  const userData = await mkdtemp(path.join(tmpdir(), 'cnv-ud-db-'))
  h = await launchApp({
    workspaceDir: dir,
    userDataDir: userData,
    canvasContent: JSON.stringify({ nodes: [], edges: [] })
  })
  server = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as typeof server
})
test.afterAll(async () => {
  await h.close()
})

/** Открыть окно, выбрать SQLite и файл, подключиться — список таблиц заполнен. */
async function openSqlite(): Promise<ReturnType<Harness['page']['getByTestId']>> {
  await h.page.locator('.create-bar__item[data-kind="database"]').click()
  const dialog = h.page.getByTestId('db-dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('select[data-field="kind"]').selectOption('sqlite')
  await dialog.locator('input[data-field="file"]').fill('shop.db')
  await expect(dialog.locator('select[data-field="table"]')).toBeDisabled()
  await dialog.getByTestId('db-connect').click()
  await expect(dialog.getByTestId('db-status')).toHaveText('✓ подключено: 2 таблицы')
  await expect(dialog.locator('select[data-field="table"] option')).toHaveText([
    'Вся база',
    'clients',
    'orders'
  ])
  return dialog
}

test('вся база: таблицы на карточке раскрываются кликом', async () => {
  const dialog = await openSqlite()
  await h.page.screenshot({ path: path.join('test-results', 'database-dialog.png') })
  await dialog.getByRole('button', { name: 'Создать карточку' }).click()
  await expect(dialog).toHaveCount(0)

  const card = h.page.locator('[data-node-kind="text"]')
  await expect(card).toHaveCount(1)
  await expect(card.locator('h3')).toHaveText('🛢 shop')
  await expect(card.locator('code').first()).toHaveText('sqlite:shop.db')
  const orders = card.locator('details', { has: h.page.locator('summary b', { hasText: 'orders' }) })
  await expect(card.locator('details')).toHaveCount(2)
  await expect(orders).not.toHaveAttribute('open')

  // Клик по заголовку таблицы раскрывает её — холст клик не перехватывает.
  const before = (await card.boundingBox())!.height
  await orders.locator('summary').click()
  await expect(orders).toHaveAttribute('open', '')
  // Раскрытая таблица не прячется за прокруткой — карточка подросла, а свернул — вернулась.
  await expect.poll(async () => (await card.boundingBox())!.height).toBeGreaterThan(before + 100)
  await expect(orders.locator('table').nth(1)).toContainText('кофе')
  await h.page.screenshot({ path: path.join('test-results', 'database-card.png') })
  await orders.locator('summary').click()
  await expect(orders).not.toHaveAttribute('open')
  await expect.poll(async () => Math.round((await card.boundingBox())!.height)).toBe(Math.round(before))
})

test('одна таблица на запись, выделенная карточка — стрелка к новой', async () => {
  await h.page.locator('[data-node-kind="text"]').click()
  const dialog = await openSqlite()
  await dialog.locator('select[data-field="table"]').selectOption('orders')
  await dialog.locator('select[data-field="write"]').selectOption('write')
  await dialog.locator('input[data-field="file"]').press('Enter')

  const card = h.page.locator('[data-node-kind="text"]', { hasText: 'shop · orders' })
  await expect(card).toHaveCount(1)
  await expect(card.locator('code').first()).toHaveText('sqlite:shop.db?table=orders&write=1')
  await expect(card.locator('details[open]')).toHaveCount(1)
  await expect(h.page.locator('[data-edge-id]')).toHaveCount(1)
})

test('поменяли тип базы — старый список таблиц сброшен', async () => {
  const dialog = await openSqlite()
  await dialog.locator('select[data-field="kind"]').selectOption('postgres')
  await expect(dialog.locator('input[data-field="host"]')).toHaveValue('localhost')
  await expect(dialog.locator('select[data-field="table"]')).toBeDisabled()
  await expect(dialog.getByTestId('db-status')).toHaveCount(0)
  await h.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

/** Вызов инструмента cnv так, как его зовёт агент: MCP по HTTP с токеном. */
async function tool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  const text = body.result.content[0]?.text ?? ''
  if (body.result.isError) throw new Error(text)
  return JSON.parse(text) as T
}

test('агент по MCP: находит карточки на холсте и работает с базой через них', async () => {
  const canvas = await tool<{ nodes: { id: string; text?: string }[] }>('get_canvas', { kinds: ['text'] })
  const whole = canvas.nodes.find((n) => n.text?.startsWith('### 🛢 shop\n'))!
  const orders = canvas.nodes.find((n) => n.text?.includes('shop · orders'))!

  expect(
    (await tool<{ rows: { name: string }[] }>('db_schema', { db: whole.id })).rows.map((r) => r.name)
  ).toEqual(['clients', 'orders'])
  // Подключена одна таблица — схема сразу о ней, без sql — её строки.
  expect(
    (await tool<{ rows: { name: string }[] }>('db_schema', { db: orders.id })).rows.map((r) => r.name)
  ).toEqual(['id', 'item', 'qty'])
  expect((await tool<{ rows: unknown[] }>('db_query', { db: orders.id })).rows).toHaveLength(2)
  expect(
    (await tool('db_query', { db: whole.id, sql: 'SELECT item FROM orders WHERE qty > $1', params: [1] }))
      .rows
  ).toEqual([{ item: 'чай' }])

  // Карточка всей базы — только чтение; карточка orders подключена с write=1.
  await expect(tool('db_query', { db: whole.id, sql: 'UPDATE orders SET qty = 0' })).rejects.toThrow(
    'только на чтение'
  )
  expect(
    await tool('db_query', { db: orders.id, sql: "UPDATE orders SET qty = qty + 1 WHERE item = 'кофе'" })
  ).toMatchObject({ changes: 1 })
})
