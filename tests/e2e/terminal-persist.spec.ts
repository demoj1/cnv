import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Ровно жалоба владельца: терминал уехал за экран — процесс не должен умирать. Это тот
 * же класс бага, что был у веб-нод: культинг за областью видимости размонтирует ноду, а
 * cleanup терминала убивает pty. Терминал с живым процессом обязан оставаться в DOM.
 *
 * Судим по делу: фоновый счётчик пишет числа в файл. Если за время «за экраном» файл
 * рос — процесс жив. Если замер — умер.
 */

let h: Harness
let workspace: string
let counter: string

const terminals = (): Promise<number> => h.page.locator('[data-node-kind="terminal"]').count()
const lastCount = async (): Promise<number> => {
  const raw = await fs.readFile(counter, 'utf8').catch(() => '')
  const nums = raw.trim().split('\n').filter(Boolean).map(Number)
  return nums.length ? nums[nums.length - 1]! : -1
}

/** Панорамим холст колесом; терминал в это время неактивен, колесо принадлежит холсту. */
async function panAway(dy: number): Promise<void> {
  await h.page.mouse.move(760, 400)
  for (let i = 0; i < 6; i++) await h.page.mouse.wheel(0, dy / 6)
  await h.page.waitForTimeout(300)
}

const offscreen = (): Promise<boolean> =>
  h.page.evaluate(() => {
    const el = document.querySelector('[data-node-kind="terminal"]')
    if (!el) return true
    const r = el.getBoundingClientRect()
    return r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth
  })

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'cnv-termp-'))
  counter = path.join(workspace, 'counter.log')
  h = await launchApp({ workspaceDir: workspace, canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  await h.page.keyboard.press('Control+0')
})

test.afterAll(async () => {
  await h?.close()
})

test('процесс в терминале переживает уход за экран', async () => {
  await h.page.keyboard.press('Control+Shift+T')
  await expect.poll(terminals, { timeout: 15000 }).toBe(1)

  await h.page.locator('[data-node-kind="terminal"]').dblclick({ position: { x: 200, y: 200 } })
  await expect
    .poll(() => h.page.locator('[data-testid="terminal-shield"]').count(), { timeout: 10000 })
    .toBe(0)

  // Фоновый счётчик: пишет число каждые 200 мс в файл рабочей папки.
  await h.page.keyboard.type(`(i=0; while true; do echo $i >> ${counter}; i=$((i+1)); sleep 0.2; done) &`)
  await h.page.keyboard.press('Enter')
  await expect.poll(lastCount, { timeout: 20000 }).toBeGreaterThan(1)

  // Возвращаем мышь холсту. Esc в терминале уходит в шелл (он нужен в vim), поэтому
  // выходим из ноды кликом по пустому месту — это штатный деселект.
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 760 } })
  await h.page.waitForTimeout(300)
  await panAway(5000)
  expect(await offscreen()).toBe(true)

  // Прямая проверка регрессии: нода не размонтирована, значит и процесс не убит.
  expect(await terminals()).toBe(1)

  const before = await lastCount()
  await h.page.waitForTimeout(3000)
  const afterOffscreen = await lastCount()
  expect(afterOffscreen, 'счётчик обязан расти, пока нода за экраном').toBeGreaterThan(before)

  // Возвращаемся — терминал жив и продолжает тот же процесс.
  await panAway(-5000)
  expect(await terminals()).toBe(1)
  await h.page.waitForTimeout(600)
  expect(await lastCount()).toBeGreaterThan(afterOffscreen)
})

test('и упрощённый вид на малом zoom его не убивает', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 700 } })
  for (let i = 0; i < 12; i++) await h.page.keyboard.press('Control+Minus')
  await h.page.waitForTimeout(1500)

  const zoom = await h.page.evaluate(() => {
    const w = document.querySelector('[data-testid="world"]') as HTMLElement
    return Number(/scale\(([\d.]+)\)/.exec(w.style.transform)?.[1])
  })
  expect(zoom).toBeLessThan(0.4)

  // Нода жива и не в упрощённом виде — иначе это тот же демонтаж процесса.
  expect(await terminals()).toBe(1)
  expect(await h.page.locator('[data-node-kind="terminal"] .node-lod').count()).toBe(0)

  const before = await lastCount()
  await h.page.waitForTimeout(1500)
  expect(await lastCount(), 'на малом zoom счётчик всё равно растёт').toBeGreaterThan(before)
})
