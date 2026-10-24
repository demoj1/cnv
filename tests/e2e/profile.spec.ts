import { expect, test, type CDPSession } from '@playwright/test'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Стенд профилирования: настоящий холст (копия workspace) и сценарии, на которых видно,
 * где тормозит, — открытие, панорама, зум, перетаскивание, поток вывода в терминале,
 * вызовы MCP. Время кадров, долгие задачи, CPU-профиль renderer на каждый сценарий.
 *
 *   PROFILE=1 PROFILE_WORKSPACE=~/cnv PROFILE_OUT=/tmp/cnv-profile npx playwright test profile
 *
 * Без PROFILE — пропускается: это не проверка, а замер.
 */

const ENABLED = process.env.PROFILE === '1'
const SOURCE = process.env.PROFILE_WORKSPACE ?? ''
const OUT = process.env.PROFILE_OUT ?? path.join(tmpdir(), 'cnv-profile')

test.describe.configure({ mode: 'serial', timeout: 300_000 })
test.skip(!ENABLED || !SOURCE, 'профилирование: PROFILE=1 и PROFILE_WORKSPACE')

let h: Harness
let cdp: CDPSession
let mcp: { url: string; token: string }
const report: Record<string, unknown> = {}

interface FrameStats {
  frames: number
  p50: number
  p95: number
  max: number
  over20ms: number
  longTasks: number
  longTaskMs: number
}

/** Время кадров и долгие задачи — пока идёт сценарий. */
async function measure(name: string, scenario: () => Promise<void>): Promise<FrameStats> {
  await h.page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; stop: boolean } }
    w.__perf = { frames: [], long: [], stop: false }
    let last = performance.now()
    const tick = (now: number): void => {
      w.__perf.frames.push(now - last)
      last = now
      if (!w.__perf.stop) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.long.push(e.duration)
    }).observe({ type: 'longtask', buffered: false })
  })
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  await scenario()
  const { profile } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile }
  await writeFile(path.join(OUT, `${name}.cpuprofile`), JSON.stringify(profile))
  const raw = await h.page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: number[]; stop: boolean } }
    w.__perf.stop = true
    return { frames: w.__perf.frames.slice(1), long: w.__perf.long }
  })
  const sorted = [...raw.frames].sort((a, b) => a - b)
  const q = (p: number): number => Math.round((sorted[Math.floor((sorted.length - 1) * p)] ?? 0) * 10) / 10
  const stats: FrameStats = {
    frames: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    max: Math.round(sorted.at(-1) ?? 0),
    over20ms: sorted.filter((f) => f > 20).length,
    longTasks: raw.long.length,
    longTaskMs: Math.round(raw.long.reduce((s, d) => s + d, 0))
  }
  report[name] = { ...stats, topSelf: topFunctions(profile) }
  return stats
}

interface CpuProfile {
  nodes: {
    id: number
    callFrame: { functionName: string; url: string; lineNumber: number }
    hitCount?: number
  }[]
  samples?: number[]
  timeDeltas?: number[]
}

/** Самые дорогие функции по собственному времени (мс). */
function topFunctions(profile: CpuProfile): { fn: string; ms: number }[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<string, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  samples.forEach((id, i) => {
    const node = byId.get(id)
    if (!node) return
    const { functionName, url, lineNumber } = node.callFrame
    const file = url.split('/').pop()?.split('?')[0] ?? ''
    const key = `${functionName || '(anon)'} ${file}:${lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0) / 1000)
  })
  return [...self]
    .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms) }))
}

async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<{ ms: number; value: T }> {
  const t0 = performance.now()
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = (await res.json()) as { result: { content: { text?: string }[]; isError?: boolean } }
  const ms = Math.round(performance.now() - t0)
  if (body.result.isError) throw new Error(body.result.content[0]?.text)
  return { ms, value: JSON.parse(body.result.content[0]?.text ?? 'null') as T }
}

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
  const workspace = await mkdtemp(path.join(tmpdir(), 'cnv-prof-ws-'))
  await cp(SOURCE, workspace, { recursive: true })
  const userData = await mkdtemp(path.join(tmpdir(), 'cnv-prof-ud-'))
  // Агенты — заглушки: настоящие Claude/Codex на сессиях человека не запускаем.
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: { agents: { commands: { claude: 'true', codex: 'true', opencode: 'true' } } },
      canvasPath: null
    })
  )
  const t0 = Date.now()
  h = await launchApp({ workspaceDir: workspace, userDataDir: userData })
  await expect.poll(() => h.page.locator('[data-node-id]').count(), { timeout: 30_000 }).toBeGreaterThan(0)
  report.open = {
    msToFirstNodes: Date.now() - t0,
    renderedNodes: await h.page.locator('[data-node-id]').count()
  }
  cdp = await h.page.context().newCDPSession(h.page)
  mcp = JSON.parse(await readFile(path.join(userData, 'mcp', 'server.json'), 'utf8')) as typeof mcp
  await h.page.waitForTimeout(3000)
})

test.afterAll(async () => {
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  await h?.close()
})

const viewportCenter = async (): Promise<{ x: number; y: number }> => {
  const box = (await h.page.getByTestId('viewport').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('панорама колесом по столу', async () => {
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(500)
  const c = await viewportCenter()
  await h.page.mouse.move(c.x, c.y)
  await measure('pan', async () => {
    for (let i = 0; i < 90; i++) {
      await h.page.mouse.wheel(i % 30 < 15 ? 120 : -120, 60)
      await h.page.waitForTimeout(16)
    }
  })
})

test('зум колесом с Ctrl', async () => {
  const c = await viewportCenter()
  await h.page.mouse.move(c.x, c.y)
  await measure('zoom', async () => {
    await h.page.keyboard.down('Control')
    for (let i = 0; i < 60; i++) {
      await h.page.mouse.wheel(0, i < 30 ? -100 : 100)
      await h.page.waitForTimeout(16)
    }
    await h.page.keyboard.up('Control')
  })
})

test('перетаскивание карточки', async () => {
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(500)
  const card = h.page.locator('[data-node-kind="text"]').first()
  const box = (await card.boundingBox())!
  await measure('drag', async () => {
    await h.page.mouse.move(box.x + 10, box.y + 10)
    await h.page.mouse.down()
    for (let i = 0; i < 60; i++) {
      await h.page.mouse.move(box.x + 10 + i * 4, box.y + 10 + Math.sin(i / 6) * 40)
      await h.page.waitForTimeout(16)
    }
    await h.page.mouse.up()
  })
  await h.page.keyboard.press('Control+z')
})

test('поток вывода в терминале, пока двигаем холст', async () => {
  const term = await tool<{ node: { id: string } }>('create_node', {
    kind: 'terminal',
    command: 'for i in $(seq 1 40000); do echo "строка $i — $(date +%N)"; done',
    x: 0,
    y: -2000
  })
  await tool('zoom_to', { ids: [term.value.node.id] })
  await h.page.waitForTimeout(300)
  const c = await viewportCenter()
  await h.page.mouse.move(c.x - 400, c.y)
  await measure('terminal-flood', async () => {
    for (let i = 0; i < 90; i++) {
      await h.page.mouse.wheel(i % 30 < 15 ? 60 : -60, 0)
      await h.page.waitForTimeout(16)
    }
  })
  await tool('delete', { ids: [term.value.node.id] })
})

test('всё на экране: панорама при сильном отдалении', async () => {
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(400)
  const c = await viewportCenter()
  await h.page.mouse.move(c.x, c.y)
  await h.page.keyboard.down('Control')
  for (let i = 0; i < 6; i++) await h.page.mouse.wheel(0, 100)
  await h.page.keyboard.up('Control')
  await h.page.waitForTimeout(600)
  report.allVisible = { rendered: await h.page.locator('[data-node-id]').count() }
  await measure('pan-all-visible', async () => {
    for (let i = 0; i < 90; i++) {
      await h.page.mouse.wheel(i % 30 < 15 ? 120 : -120, 60)
      await h.page.waitForTimeout(16)
    }
  })
})

test('8 агентов шевелятся (спиннеры, как у Claude), холст стоит и двигается', async () => {
  // Как TUI агента: строка статуса перерисовывается ~12 раз в секунду, без новых строк.
  const spinner =
    "i=0; while true; do i=$((i+1)); printf '\\r\\033[2K⠋ Думаю… %d токенов · esc — прервать' $i; sleep 0.08; done"
  const ids: string[] = []
  for (let k = 0; k < 8; k++) {
    const t = await tool<{ node: { id: string } }>('create_node', {
      kind: 'terminal',
      command: spinner,
      x: 300_000 + (k % 4) * 760,
      y: Math.floor(k / 4) * 460
    })
    ids.push(t.value.node.id)
  }
  await tool('zoom_to', { ids })
  await h.page.waitForTimeout(1500)
  const cpu0 = await h.app.evaluate(() => process.cpuUsage())
  const t0 = Date.now()
  await measure('agents-idle', async () => {
    await h.page.waitForTimeout(3000)
  })
  const cpu1 = await h.app.evaluate(() => process.cpuUsage())
  const wall = Date.now() - t0
  report.mainCpuWhileAgentsIdle = {
    percent: Math.round(((cpu1.user - cpu0.user + cpu1.system - cpu0.system) / 1000 / wall) * 100)
  }
  const c = await viewportCenter()
  await h.page.mouse.move(c.x, c.y)
  await measure('agents-pan', async () => {
    for (let i = 0; i < 90; i++) {
      await h.page.mouse.wheel(i % 30 < 15 ? 120 : -120, 40)
      await h.page.waitForTimeout(16)
    }
  })
  // Агенты за кадром: ушли на другой стол — сколько они стоят, когда их не видно.
  await h.page.keyboard.press('Alt+1')
  await h.page.waitForTimeout(800)
  await measure('agents-offscreen', async () => {
    await h.page.waitForTimeout(3000)
  })
  await tool('delete', { ids })
})

test('8 агентов в стиле Ink: каждый кадр перерисовывает 28 строк, 12 к/с', async () => {
  const ink = path.join(OUT, 'ink-sim.py')
  await writeFile(ink, await readFile(process.env.PROFILE_INK ?? '', 'utf8').catch(() => ''))
  const ids: string[] = []
  for (let k = 0; k < 8; k++) {
    const t = await tool<{ node: { id: string } }>('create_node', {
      kind: 'terminal',
      command: `python3 ${ink}`,
      x: 400_000 + (k % 4) * 760,
      y: Math.floor(k / 4) * 460
    })
    ids.push(t.value.node.id)
  }
  await tool('zoom_to', { ids })
  await h.page.waitForTimeout(1500)
  const cpu0 = await h.app.evaluate(() => process.cpuUsage())
  const t0 = Date.now()
  await measure('ink-idle', async () => {
    await h.page.waitForTimeout(3000)
  })
  const cpu1 = await h.app.evaluate(() => process.cpuUsage())
  report.mainCpuWhileInk = {
    percent: Math.round(((cpu1.user - cpu0.user + cpu1.system - cpu0.system) / 1000 / (Date.now() - t0)) * 100)
  }
  const c = await viewportCenter()
  await h.page.mouse.move(c.x, c.y)
  await measure('ink-pan', async () => {
    for (let i = 0; i < 90; i++) {
      await h.page.mouse.wheel(i % 30 < 15 ? 120 : -120, 40)
      await h.page.waitForTimeout(16)
    }
  })
  await h.page.keyboard.press('Alt+1')
  await h.page.waitForTimeout(800)
  await measure('ink-offscreen', async () => {
    await h.page.waitForTimeout(3000)
  })
  await tool('delete', { ids })
})

test('вызовы MCP на настоящем холсте', async () => {
  const calls: Record<string, number> = {}
  calls.get_canvas = (await tool('get_canvas', { max_text: 400 })).ms
  calls.find_nodes = (await tool('find_nodes', { text: 'а' })).ms
  const ops = Array.from({ length: 100 }, (_, i) => ({
    op: 'create_node',
    ref: `n${i}`,
    kind: 'text',
    text: `PROF ${i}`,
    x: 200_000 + (i % 10) * 300,
    y: Math.floor(i / 10) * 200
  }))
  const batch = await tool<{ refs: Record<string, string> }>('batch', { ops })
  calls.batch_100 = batch.ms
  const ids = Object.values(batch.value.refs)
  calls.layout_grid_100 = (await tool('layout', { ids, mode: 'grid' })).ms
  calls.check_overlaps = (await tool('check_overlaps', { ids })).ms
  calls.screenshot_nodes = (await tool('screenshot', { ids: ids.slice(0, 20) })).ms
  calls.history = (await tool('history', { limit: 50 })).ms
  calls.delete_100 = (await tool('delete', { ids })).ms
  report.mcp = calls
})

test('память renderer', async () => {
  const mem = await h.page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    return {
      heapMb: m ? Math.round(m.usedJSHeapSize / 1e6) : null,
      domNodes: document.getElementsByTagName('*').length,
      nodesRendered: document.querySelectorAll('[data-node-id]').length,
      webviews: document.querySelectorAll('webview').length,
      xterms: document.querySelectorAll('.xterm').length
    }
  })
  report.memory = mem
})
