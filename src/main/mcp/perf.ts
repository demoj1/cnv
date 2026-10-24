import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Замер живого cnv изнутри — без внешнего отладчика: CDP окна холста (webContents.debugger)
 * даёт CPU-профиль renderer, rAF — время кадров, PerformanceObserver — долгие задачи,
 * app.getAppMetrics — нагрузку всех процессов Electron, включая GPU и веб-страницы.
 */

export interface PerfReport {
  seconds: number
  frames: { count: number; fps: number; p50: number; p95: number; max: number; over20ms: number }
  longTasks: { count: number; totalMs: number; maxMs: number }
  /** Собственное время самых дорогих функций renderer за замер. */
  topFunctions: { fn: string; ms: number }[]
  /** Средняя загрузка процессов за замер, % одного ядра. */
  processes: { type: string; name: string; pid: number; cpu: number; memoryMb: number }[]
  dom: { elements: number; nodesRendered: number; xterms: number; webviews: number; images: number }
  profileFile?: string
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples?: number[]
  timeDeltas?: number[]
}

function topFunctions(profile: CpuProfile): { fn: string; ms: number }[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<string, number>()
  ;(profile.samples ?? []).forEach((id, i) => {
    const node = byId.get(id)
    if (!node) return
    const { functionName, url, lineNumber } = node.callFrame
    const file = url.split('/').pop()?.split('?')[0] ?? ''
    const key = `${functionName || '(anon)'} ${file}:${lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000)
  })
  return [...self]
    .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([fn, ms]) => ({ fn, ms: Math.round(ms * 10) / 10 }))
}

const START_FRAMES = `(() => {
  const w = window; w.__cnvPerf = { frames: [], long: [], stop: false }
  let last = performance.now()
  const tick = (now) => { w.__cnvPerf.frames.push(now - last); last = now; if (!w.__cnvPerf.stop) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  w.__cnvPerf.obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__cnvPerf.long.push(e.duration) })
  w.__cnvPerf.obs.observe({ type: 'longtask', buffered: false })
})()`

const STOP_FRAMES = `(() => {
  const p = window.__cnvPerf; p.stop = true; p.obs.disconnect()
  return {
    frames: p.frames.slice(1),
    long: p.long,
    dom: {
      elements: document.getElementsByTagName('*').length,
      nodesRendered: document.querySelectorAll('[data-node-id]').length,
      xterms: document.querySelectorAll('.xterm').length,
      webviews: document.querySelectorAll('webview').length,
      images: document.images.length
    }
  }
})()`

export async function profileWindow(
  win: BrowserWindow,
  seconds: number,
  outDir: string
): Promise<PerfReport> {
  const wc = win.webContents
  const dbg = wc.debugger
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  try {
    await dbg.sendCommand('Profiler.enable')
    await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 250 })
    await wc.executeJavaScript(START_FRAMES)
    const metrics0 = app.getAppMetrics()
    await dbg.sendCommand('Profiler.start')
    await new Promise((r) => setTimeout(r, seconds * 1000))
    const { profile } = (await dbg.sendCommand('Profiler.stop')) as { profile: CpuProfile }
    const metrics1 = app.getAppMetrics()
    const raw = (await wc.executeJavaScript(STOP_FRAMES)) as {
      frames: number[]
      long: number[]
      dom: PerfReport['dom']
    }

    const sorted = [...raw.frames].sort((a, b) => a - b)
    const q = (p: number): number => Math.round((sorted[Math.floor((sorted.length - 1) * p)] ?? 0) * 10) / 10
    // getAppMetrics: percentCPUUsage — средняя загрузка с прошлого вызова; берём второй замер.
    const before = new Map(metrics0.map((m) => [m.pid, m]))
    const processes = metrics1
      .map((m) => ({
        type: m.type,
        name: m.name ?? m.serviceName ?? '',
        pid: m.pid,
        cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
        memoryMb: Math.round((m.memory.workingSetSize ?? 0) / 1024)
      }))
      .filter((p) => before.has(p.pid) || p.cpu > 0)
      .sort((a, b) => b.cpu - a.cpu)

    fs.mkdirSync(outDir, { recursive: true })
    const profileFile = path.join(outDir, `cnv-${Date.now()}.cpuprofile`)
    fs.writeFileSync(profileFile, JSON.stringify(profile))
    return {
      seconds,
      frames: {
        count: sorted.length,
        fps: Math.round(sorted.length / seconds),
        p50: q(0.5),
        p95: q(0.95),
        max: Math.round(sorted.at(-1) ?? 0),
        over20ms: sorted.filter((f) => f > 20).length
      },
      longTasks: {
        count: raw.long.length,
        totalMs: Math.round(raw.long.reduce((s, d) => s + d, 0)),
        maxMs: Math.round(Math.max(0, ...raw.long))
      },
      topFunctions: topFunctions(profile),
      processes,
      dom: raw.dom,
      profileFile
    }
  } finally {
    if (attachedHere && dbg.isAttached()) dbg.detach()
  }
}
