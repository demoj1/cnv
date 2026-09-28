import { expect, test } from '@playwright/test'
import fs, { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { cameraState, launchApp, type Harness } from './helpers'

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

test('скролл в активном терминале не просачивается на холст', async () => {
  // Ровно жалоба владельца: терминал активен, крутим колесо над ним — холст ездить
  // не должен. Ввод настоящий, через X11: синтетика идёт мимо реального пути.
  const hasX = Boolean(process.env.DISPLAY)
  test.skip(!hasX, 'нужен X-дисплей: запускать под xvfb-run')

  await expect
    .poll(() => h.page.locator('[data-testid="terminal-shield"]').count(), { timeout: 10000 })
    .toBe(0)

  const box = await h.page.locator('[data-node-kind="terminal"]').boundingBox()
  if (!box) throw new Error('нет терминала')
  // xdotool двигает курсор в координатах экрана, а рамка ноды — в координатах окна.
  const content = await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('нет окна')
    return win.getContentBounds()
  })
  const at = {
    x: Math.round(content.x + box.x + box.width / 2),
    y: Math.round(content.y + box.y + box.height / 2)
  }
  const win = execFileSync('xdotool', ['search', '--name', 'cnv'], { env: process.env })
    .toString()
    .trim()
    .split('\n')
    .pop()
  execFileSync('xdotool', ['windowraise', String(win)], { env: process.env })
  execFileSync('xdotool', ['mousemove', '--sync', String(at.x), String(at.y)], { env: process.env })

  // Курсор обязан быть над терминалом, иначе тест проверяет пустой холст.
  const overTerminal = await h.page.evaluate(
    (p) => Boolean(document.elementFromPoint(p.x, p.y)?.closest('[data-node-kind="terminal"]')),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  )
  expect(overTerminal, 'курсор должен стоять над терминалом').toBe(true)

  const before = await cameraState(h.page)
  for (let i = 0; i < 4; i++) execFileSync('xdotool', ['click', '5'], { env: process.env })
  await h.page.waitForTimeout(400)
  expect(await cameraState(h.page)).toEqual(before)

  // И с Ctrl тоже: пока мышь у терминала, масштаб холста не его дело.
  execFileSync('xdotool', ['keydown', 'ctrl'], { env: process.env })
  execFileSync('xdotool', ['click', '4'], { env: process.env })
  await h.page.waitForTimeout(300)
  execFileSync('xdotool', ['keyup', 'ctrl'], { env: process.env })
  expect((await cameraState(h.page)).zoom).toBe(before.zoom)
})
