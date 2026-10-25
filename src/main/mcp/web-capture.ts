import type { WebContents } from 'electron'

/**
 * Снимок веб-ноды через DevTools-протокол. `capturePage` отдаёт только то, что Chromium
 * отрисовал, а у ноды за краем окна это полоска, попавшая в кадр. CDP рисует страницу
 * заново — на нужной ширине и во всю высоту, камеру человека не трогая.
 */

export interface WebCaptureOptions {
  /** Ширина вёрстки в CSS-пикселях (как окно телефона на 390). */
  width?: number
  /** Вся страница, а не только видимое окно. */
  full?: boolean
}

/** Выше — PNG тяжелеет без толку, а Chromium режет текстуры. */
const MAX_HEIGHT = 16000
/** Время странице перестроиться под новую ширину. */
const RELAYOUT_MS = 300

interface LayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number }
  cssContentSize: { width: number; height: number }
}

export async function captureWeb(guest: WebContents, opts: WebCaptureOptions = {}): Promise<string> {
  const dbg = guest.debugger
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  let overridden = false
  try {
    let metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as LayoutMetrics
    if (opts.width) {
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: Math.round(opts.width),
        height: Math.max(1, Math.round(metrics.cssLayoutViewport.clientHeight)),
        deviceScaleFactor: 1,
        mobile: false
      })
      overridden = true
      await new Promise((r) => setTimeout(r, RELAYOUT_MS))
      metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as LayoutMetrics
    }
    const view = metrics.cssLayoutViewport
    const width = opts.width ? Math.round(opts.width) : view.clientWidth
    const height = opts.full ? metrics.cssContentSize.height : view.clientHeight
    const { data } = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height: Math.min(MAX_HEIGHT, Math.max(1, Math.ceil(height))), scale: 1 }
    })) as { data: string }
    return data
  } finally {
    if (overridden) await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
    if (attachedHere && dbg.isAttached()) dbg.detach()
  }
}
