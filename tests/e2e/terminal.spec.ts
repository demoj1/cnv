import { expect, test } from '@playwright/test'
import fs, { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Терминал — настоящий PTY, а не пайп: без него нет ни цветов, ни `vim`, ни Ctrl+C.
 * Проверяем именно это: команда выполняется живым шеллом, вывод приходит на экран,
 * а рабочая папка переживает перезапуск приложения.
 */

let h: Harness
/** Папку держим сами: harness сносит свою временную, а тесту нужен перезапуск на том же файле. */
let workspace: string

const screenText = (): Promise<string> => h.page.locator('[data-testid="terminal-screen"]').innerText()

/** Печатаем в активный терминал так же, как печатает человек. */
async function type(text: string): Promise<void> {
  await h.page.keyboard.type(text)
  await h.page.keyboard.press('Enter')
  await h.page.waitForTimeout(600)
}

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'cnv-term-'))
  h = await launchApp({ workspaceDir: workspace, canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
})

test.afterAll(async () => {
  await h?.close()
  await rm(workspace, { recursive: true, force: true })
})

test('терминал создаётся хоткеем и поднимает живой шелл', async () => {
  await h.page.keyboard.press('Control+Shift+T')
  await expect.poll(() => h.page.locator('[data-node-kind="terminal"]').count(), { timeout: 15000 }).toBe(1)
  await expect(h.page.locator('[data-testid="terminal-screen"] .xterm')).toHaveCount(1)

  // Процесс действительно запущен: у main есть живой pty с этой нодой.
  await expect.poll(() => screenText(), { timeout: 20000 }).not.toBe('')
})

test('команда выполняется настоящим шеллом', async () => {
  await h.page.locator('[data-node-kind="terminal"]').dblclick({ position: { x: 200, y: 200 } })
  await expect
    .poll(() => h.page.locator('[data-testid="terminal-shield"]').count(), { timeout: 10000 })
    .toBe(0)

  await type('echo CNV_TERM_ALIVE')
  await expect.poll(() => screenText(), { timeout: 20000 }).toContain('CNV_TERM_ALIVE')
})

test('cd запоминается в канвасе и переживает перезапуск', async () => {
  await type('cd /tmp')
  // Папку приносит main, опрашивая ядро: шелл про свой cd никому не сообщает.
  await expect
    .poll(
      async () => {
        const raw = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))
        return raw.nodes[0]?.['x-cnv']?.terminal?.cwd
      },
      { timeout: 20000 }
    )
    .toBe('/tmp')

  await h.close()
  h = await launchApp({ workspaceDir: workspace })
  await expect.poll(() => h.page.locator('[data-node-kind="terminal"]').count(), { timeout: 15000 }).toBe(1)

  // Процесс перезапуск не пережил и не должен, а вот папка — пережила.
  await h.page.locator('[data-node-kind="terminal"]').dblclick({ position: { x: 200, y: 200 } })
  await expect
    .poll(() => h.page.locator('[data-testid="terminal-shield"]').count(), { timeout: 10000 })
    .toBe(0)
  await type('pwd')
  await expect.poll(() => screenText(), { timeout: 20000 }).toContain('/tmp')
})
