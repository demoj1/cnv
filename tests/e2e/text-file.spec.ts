import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness
let outside: string
let source: string

test.beforeAll(async () => {
  outside = await mkdtemp(path.join(tmpdir(), 'cnv-outside-'))
  source = path.join(outside, 'graph.dot')
  await fs.writeFile(source, 'digraph { a -> b }\n', 'utf8')
  const workspace = await mkdtemp(path.join(tmpdir(), 'cnv-ws-'))
  await fs.mkdir(path.join(workspace, 'attachments'))
  await fs.writeFile(path.join(workspace, 'note.md'), '# Заметка\n\nпервая версия\n', 'utf8')
  await fs.writeFile(path.join(workspace, 'attachments/graph.dot'), 'digraph { a -> b }\n', 'utf8')
  const canvas = {
    nodes: [
      { id: 'md', type: 'file', file: 'note.md', x: 40, y: 40, width: 420, height: 300 },
      {
        id: 'dot',
        type: 'file',
        file: 'attachments/graph.dot',
        x: 500,
        y: 40,
        width: 420,
        height: 300,
        'x-cnv': { source }
      }
    ],
    edges: []
  }
  h = await launchApp({ workspaceDir: workspace, canvasContent: JSON.stringify(canvas) })
})

test.afterAll(async () => {
  await h.close()
  await rm(h.workspaceRoot, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const md = (): ReturnType<Harness['page']['locator']> => h.page.locator('[data-node-id="md"]')
const dot = (): ReturnType<Harness['page']['locator']> => h.page.locator('[data-node-id="dot"]')

test('текстовый файл показан содержимым: markdown — разметкой, прочее — как есть', async () => {
  await expect(md().locator('.node-text h1')).toHaveText('Заметка')
  await expect(dot().locator('.node-textfile__pre')).toContainText('a -> b')
})

test('файл поменялся на диске — карточка перечитала его', async () => {
  await fs.writeFile(path.join(h.workspaceRoot, 'note.md'), '# Заметка\n\nвторая версия\n', 'utf8')
  await expect(md()).toContainText('вторая версия', { timeout: 5000 })
  // Перезагрузка с диска видна: рамка вспыхнула.
  await expect(md().locator('[data-testid="text-file"]')).toHaveAttribute('data-reloads', '1')
  await expect(md().locator('.node-textfile__pulse')).toHaveCount(1)
})

test('оригинал снаружи workspace поменялся — нода догнала его без опроса', async () => {
  await fs.writeFile(source, 'digraph { a -> c }\n', 'utf8')
  await expect(dot().locator('.node-textfile__pre')).toContainText('a -> c', { timeout: 5000 })
})

test('правка карточки пишется в файл, у копии — в оригинал', async () => {
  await dot().locator('.node-textfile__pre').dblclick()
  await h.page.keyboard.press('Control+End')
  await h.page.keyboard.type('// правка')
  await h.page.keyboard.press('Escape')
  await expect.poll(() => fs.readFile(source, 'utf8'), { timeout: 5000 }).toContain('// правка')
  await expect
    .poll(() => fs.readFile(path.join(h.workspaceRoot, 'attachments/graph.dot'), 'utf8'), { timeout: 5000 })
    .toContain('// правка')
})

test('файл поправили снаружи во время правки — спрашиваем, а не затираем', async () => {
  await md().locator('.node-text').dblclick()
  await h.page.keyboard.press('Control+End')
  // Чужая правка успевает раньше, чем наша уйдёт на диск.
  const file = path.join(h.workspaceRoot, 'note.md')
  await fs.writeFile(file, '# Снаружи\n', 'utf8')
  await fs.utimes(file, new Date(), new Date(Date.now() + 5000))
  await h.page.keyboard.type('моё')
  await expect(md().locator('[data-testid="text-file-conflict"]')).toBeVisible({ timeout: 5000 })
  expect(await fs.readFile(file, 'utf8')).toBe('# Снаружи\n')
  await md().locator('[data-testid="text-file-overwrite"]').click()
  await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 5000 }).toContain('моё')
})
