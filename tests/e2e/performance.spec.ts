import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

let h: Harness
const CANVAS = 'bench-500.canvas'

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cnv-bench-'))
  execFileSync('node', ['scripts/gen-bench-canvas.mjs', dir, '500', '6'], { cwd: process.cwd() })
  h = await launchApp({
    workspaceDir: dir,
    canvasName: CANVAS,
    canvasContent: await fs.readFile(path.join(dir, CANVAS), 'utf8')
  })
  await h.page.waitForTimeout(2500)
})

test.afterAll(async () => {
  await h.close()
})

test('канвас на 500 нод открывается и рендерит только видимое', async () => {
  const saved = JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))
  expect(saved.nodes).toHaveLength(500)

  const rendered = await h.page.locator('[data-node-id]').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(120)
})

test('pan держит целевой fps', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 20 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(600)

  const result = await h.page.evaluate(async () => {
    const viewport = document.querySelector('[data-testid="viewport"]') as HTMLElement
    const frames: number[] = []
    let last = performance.now()
    let running = true

    const tick = (now: number): void => {
      frames.push(now - last)
      last = now
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    // Имитируем непрерывный pan колёсиком в течение двух секунд.
    const started = performance.now()
    while (performance.now() - started < 2000) {
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 24,
          deltaX: 12,
          clientX: 500,
          clientY: 400,
          bubbles: true,
          cancelable: true
        })
      )
      await new Promise((r) => requestAnimationFrame(r))
    }
    running = false
    await new Promise((r) => requestAnimationFrame(r))

    const sorted = frames.slice(5).sort((a, b) => a - b)
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
    return {
      frames: sorted.length,
      median: at(0.5),
      p95: at(0.95),
      rendered: document.querySelectorAll('[data-node-id]').length
    }
  })

  console.log(
    `pan на 500 нодах: кадров ${result.frames}, медиана ${result.median.toFixed(1)} мс, ` +
      `p95 ${result.p95.toFixed(1)} мс, в DOM ${result.rendered} нод`
  )

  expect(result.frames).toBeGreaterThan(30)
  // 60 fps = 16.7 мс на кадр; берём запас на шум тестового прогона.
  expect(result.median).toBeLessThan(20)
  expect(result.p95).toBeLessThan(40)
})

test('zoom до обзора всего канваса остаётся отзывчивым', async () => {
  const result = await h.page.evaluate(async () => {
    const viewport = document.querySelector('[data-testid="viewport"]') as HTMLElement
    const frames: number[] = []
    let last = performance.now()
    let running = true
    const tick = (now: number): void => {
      frames.push(now - last)
      last = now
      if (running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    for (let i = 0; i < 90; i++) {
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: 30,
          ctrlKey: true,
          clientX: 500,
          clientY: 400,
          bubbles: true,
          cancelable: true
        })
      )
      await new Promise((r) => requestAnimationFrame(r))
    }
    running = false
    await new Promise((r) => requestAnimationFrame(r))

    const world = document.querySelector('[data-testid="world"]') as HTMLElement
    const sorted = frames.slice(5).sort((a, b) => a - b)
    return {
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      zoom: Number(/scale\(([\d.]+)\)/.exec(world.style.transform)?.[1]),
      rendered: document.querySelectorAll('[data-node-id]').length
    }
  })

  console.log(
    `zoom out до ${result.zoom.toFixed(3)}: медиана ${result.median.toFixed(1)} мс, в DOM ${result.rendered} нод`
  )
  expect(result.zoom).toBeLessThan(0.3)
  expect(result.median).toBeLessThan(25)
})

test('на малом zoom ноды переходят в упрощённый вид', async () => {
  const lod = await h.page.locator('.node-lod, .node-text--lod').count()
  expect(lod).toBeGreaterThan(0)

  // Живые веб-ноды упрощения не знают — им порог выгрузки надо включить явно.
  await h.page.evaluate(() => window.api.settings.patch({ web: { lodZoomThreshold: 0.35 } }))
  await expect(h.page.locator('webview')).toHaveCount(0)
})
