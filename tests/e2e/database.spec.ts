import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

/** Кнопка «База данных» слева: строка подключения → карточка с таблицами базы. */

let h: Harness

test.beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cnv-ws-'))
  const db = new DatabaseSync(path.join(dir, 'shop.db'))
  db.exec(`
    CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT, qty INTEGER);
    INSERT INTO orders (item, qty) VALUES ('чай', 2), ('кофе', 1);
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT);
  `)
  db.close()
  h = await launchApp({ workspaceDir: dir, canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
})
test.afterAll(async () => {
  await h.close()
})

test('вся база: карточка со строкой подключения и списком таблиц', async () => {
  await h.page.locator('.create-bar__item[data-kind="database"]').click()
  const input = h.page.getByTestId('text-prompt').locator('input')
  await input.fill('shop.db')
  await input.press('Enter')
  const card = h.page.locator('[data-node-kind="text"]')
  await expect(card).toHaveCount(1)
  await expect(card.locator('h3')).toHaveText('🛢 shop')
  await expect(card.locator('code').first()).toHaveText('sqlite:shop.db')
  await expect(card.locator('tbody tr')).toHaveCount(2)
  await expect(card.locator('tbody')).toContainText('orders')
  await expect(card.locator('tbody')).toContainText('clients')
})

test('одна таблица и выделенная нода: колонки, строки и стрелка к карточке', async () => {
  await h.page.locator('[data-node-kind="text"]').click()
  await h.page.locator('.create-bar__item[data-kind="database"]').click()
  const input = h.page.getByTestId('text-prompt').locator('input')
  await input.fill('sqlite:shop.db?table=orders')
  await input.press('Enter')
  const card = h.page.locator('[data-node-kind="text"]', { hasText: 'shop · orders' })
  await expect(card).toHaveCount(1)
  await expect(card.locator('table')).toHaveCount(2)
  await expect(card.locator('table').nth(1)).toContainText('кофе')
  await expect(h.page.locator('[data-edge-id]')).toHaveCount(1)
  await h.page.screenshot({ path: path.join('test-results', 'database-card.png') })
})
