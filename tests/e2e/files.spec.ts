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

test('сохранение без правок не трогает содержимое канваса', async () => {
  const before = JSON.parse(await fs.readFile(FIXTURE, 'utf8'))
  await h.page.keyboard.press('Control+s')
  await h.page.waitForTimeout(800)
  const after = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))

  // Приписаться может только служебный x-cnv; ноды и рёбра — байт в байт те же.
  expect(after.nodes).toEqual(before.nodes)
  expect(after.edges).toEqual(before.edges)
  expect(
    Object.keys(after)
      .filter((k) => k !== 'x-cnv')
      .sort()
  ).toEqual(Object.keys(before).sort())
})

test('состояние вида живёт в самом канвасе, рядом ничего не заводится', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 40, y: 40 } })
  await h.page.mouse.wheel(0, 300)
  // Камера уезжает в документ через секунду после остановки, файл — ещё через секунду.
  await h.page.waitForTimeout(3500)

  const doc = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))
  expect(typeof doc['x-cnv'].camera.y).toBe('number')
  expect(doc['x-cnv'].camera.y).toBeLessThan(0)

  // Файл ровно один: никаких .state.json и прочего соседства.
  const siblings = await fs.readdir(path.dirname(h.canvasFile))
  expect(siblings.filter((f) => f.includes('.state.json'))).toEqual([])

  // Ноды и рёбра от служебного поля не пострадали.
  expect(doc.nodes).toHaveLength(4)
  expect(doc.edges).toHaveLength(2)
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
