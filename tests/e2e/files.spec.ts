import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness
const FIXTURE = path.resolve('tests/fixtures/obsidian-authored.canvas')

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: await fs.readFile(FIXTURE, 'utf8') })
  await fs.writeFile(path.join(h.workspaceRoot, 'note.md'), '# Заметка\n', 'utf8')
  await h.page.waitForTimeout(600)
})

test.afterAll(async () => {
  await h.close()
})

test('канвас от Obsidian открывается: все типы нод на месте', async () => {
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
  const after = await fs.readFile(h.canvasFile, 'utf8')
  expect(after).toBe(before)
})

test('состояние вида уезжает в sidecar, а не в .canvas', async () => {
  const before = await fs.readFile(h.canvasFile, 'utf8')
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 40, y: 40 } })
  await h.page.mouse.wheel(0, 300)
  await h.page.waitForTimeout(1600)

  const after = await fs.readFile(h.canvasFile, 'utf8')
  expect(after).toBe(before)

  const sidecar = JSON.parse(
    await fs.readFile(`${h.canvasFile.replace(/([^/]+)$/, '.$1')}.state.json`, 'utf8')
  )
  expect(typeof sidecar.camera.y).toBe('number')
  expect(sidecar.camera.y).toBeLessThan(0)
})

test('автосохранение пишет изменения и не теряет посторонние поля', async () => {
  await h.page.locator('[data-testid="viewport"]').dblclick({ position: { x: 700, y: 620 } })
  await h.page.keyboard.type('новая нода')
  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(1600)

  const saved = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))
  expect(saved.nodes).toHaveLength(5)
  expect(saved.edges).toHaveLength(2)
  expect(saved.edges[1].toEnd).toBe('none')
  expect(saved.nodes.every((n: { x: number }) => Number.isInteger(n.x))).toBe(true)
})

test('внешнее изменение без локальных правок перезагружает канвас', async () => {
  const file = h.canvasFile
  const doc = JSON.parse(await fs.readFile(file, 'utf8'))
  doc.nodes = doc.nodes.filter((n: { type: string }) => n.type !== 'group')
  await fs.writeFile(file, JSON.stringify(doc))
  await h.page.waitForTimeout(2500)

  await expect(h.page.locator('[data-node-kind="group"]')).toHaveCount(0)
  await expect(h.page.locator('[data-node-id]')).toHaveCount(4)
})

test('приложение держит ровно один канвас — тот, что передан аргументом', async () => {
  const current = await h.page.evaluate(() => window.api.canvas.currentFile())
  expect(current).toBe(h.canvasFile)

  // Никакого выбора файлов в интерфейсе нет: это скретчпад, а не менеджер проектов.
  await expect(h.page.locator('.sidebar')).toHaveCount(0)
})

test('несохранённое дописывается в файл перед закрытием окна', async () => {
  // Свой каталог: close() у общего харнесса удалил бы его до проверки.
  const dir = await mkdtemp(path.join(tmpdir(), 'cnv-flush-'))
  const fresh = await launchApp({ workspaceDir: dir, canvasContent: '{"nodes":[],"edges":[]}' })
  await fresh.page.locator('[data-testid="viewport"]').dblclick({ position: { x: 400, y: 300 } })
  await fresh.page.keyboard.type('успеть до закрытия')
  await fresh.page.keyboard.press('Escape')

  // Закрываем сразу, не дожидаясь автосохранения.
  const file = fresh.canvasFile
  await fresh.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await fresh.app.waitForEvent('close').catch(() => undefined)

  const saved = await fs.readFile(file, 'utf8')
  expect(saved).toContain('успеть до закрытия')
  await rm(dir, { recursive: true, force: true })
})
