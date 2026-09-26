import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness
const FIXTURE = path.resolve('tests/fixtures/obsidian-authored.canvas')

test.beforeAll(async () => {
  h = await launchApp()
  await fs.copyFile(FIXTURE, path.join(h.workspaceRoot, 'obsidian.canvas'))
  await fs.writeFile(path.join(h.workspaceRoot, 'note.md'), '# Заметка\n', 'utf8')
  await h.page.waitForSelector('[data-canvas="obsidian.canvas"]')
})

test.afterAll(async () => {
  await h.close()
})

test('канвас от Obsidian открывается: все типы нод на месте', async () => {
  await h.page.click('[data-canvas="obsidian.canvas"] .sidebar__open')
  await h.page.waitForTimeout(500)

  const kinds = await h.page.evaluate(() =>
    [...document.querySelectorAll('[data-node-kind]')].map((el) => (el as HTMLElement).dataset.nodeKind)
  )
  expect(kinds.sort()).toEqual(['file', 'group', 'text', 'web'].sort())
  await expect(h.page.locator('.node-text h1')).toHaveText('Заголовок')
  await expect(h.page.locator('.node-group__label')).toHaveText('Группа')
})

test('сохранение без правок не меняет файл', async () => {
  const before = await fs.readFile(FIXTURE, 'utf8')
  await h.page.keyboard.press('Control+s')
  await h.page.waitForTimeout(600)
  const after = await fs.readFile(path.join(h.workspaceRoot, 'obsidian.canvas'), 'utf8')
  expect(after).toBe(before)
})

test('состояние вида уезжает в sidecar, а не в .canvas', async () => {
  const before = await fs.readFile(path.join(h.workspaceRoot, 'obsidian.canvas'), 'utf8')
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 40, y: 40 } })
  await h.page.mouse.wheel(0, 300)
  await h.page.waitForTimeout(1600)

  const after = await fs.readFile(path.join(h.workspaceRoot, 'obsidian.canvas'), 'utf8')
  expect(after).toBe(before)

  const sidecar = JSON.parse(
    await fs.readFile(path.join(h.workspaceRoot, '.obsidian.canvas.state.json'), 'utf8')
  )
  expect(typeof sidecar.camera.y).toBe('number')
  expect(sidecar.camera.y).toBeLessThan(0)
})

test('автосохранение пишет изменения и не теряет посторонние поля', async () => {
  await h.page.locator('[data-testid="viewport"]').dblclick({ position: { x: 700, y: 620 } })
  await h.page.keyboard.type('новая нода')
  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(1600)

  const saved = JSON.parse(await fs.readFile(path.join(h.workspaceRoot, 'obsidian.canvas'), 'utf8'))
  expect(saved.nodes).toHaveLength(5)
  expect(saved.edges).toHaveLength(2)
  expect(saved.edges[1].toEnd).toBe('none')
  expect(saved.nodes.every((n: { x: number }) => Number.isInteger(n.x))).toBe(true)
})

test('внешнее изменение без локальных правок перезагружает канвас', async () => {
  const file = path.join(h.workspaceRoot, 'obsidian.canvas')
  const doc = JSON.parse(await fs.readFile(file, 'utf8'))
  doc.nodes = doc.nodes.filter((n: { type: string }) => n.type !== 'group')
  await fs.writeFile(file, JSON.stringify(doc))
  await h.page.waitForTimeout(2500)

  await expect(h.page.locator('[data-node-kind="group"]')).toHaveCount(0)
  await expect(h.page.locator('[data-node-id]')).toHaveCount(4)
})

test('новый канвас создаётся и появляется в панели', async () => {
  await h.page.click('.sidebar__head button[title="Новый канвас"]')
  await h.page.waitForTimeout(700)
  const files = await fs.readdir(h.workspaceRoot)
  expect(files.some((f) => f.startsWith('Новый канвас') && f.endsWith('.canvas'))).toBe(true)
  await expect(h.page.locator('[data-node-id]')).toHaveCount(0)
})
