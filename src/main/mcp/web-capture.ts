import { nativeImage, type NativeImage, type WebContents } from 'electron'

/**
 * Снимок веб-ноды через DevTools-протокол. Гость `<webview>` рисует только своё реальное
 * окно: `captureBeyondViewport` и растянутая эмуляцией высота дают повторы кусков. Поэтому
 * ширину задаёт эмуляция, а вся страница снимается по экранам — прокручиваем, снимаем,
 * склеиваем по пикселям. Ноду за краем окна холст на это время ставит в кадр (webStage),
 * иначе Chromium её не рисует и кадр не приходит никогда. Камеру человека это не трогает.
 */

export interface WebCaptureOptions {
  /** Ширина вёрстки в CSS-пикселях (как окно телефона на 390). */
  width?: number
  /** Вся страница, а не только видимое окно. */
  full?: boolean
}

/** Выше — PNG тяжелеет без толку. */
const MAX_HEIGHT = 16000
/** Время странице перестроиться под новую ширину. */
const RELAYOUT_MS = 250
/** Кадр так и не пришёл — не висим вечно. */
const CAPTURE_TIMEOUT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${ms / 1000} с`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** Прокрутить и дождаться двух кадров — снимок увидит уже прокрученную страницу. */
const SCROLL = (y: number): string =>
  `new Promise((r) => { scrollTo(0, ${y}); requestAnimationFrame(() => requestAnimationFrame(() => r(scrollY))) })`

/** Липкие шапки и плавающие кнопки на кусках после первого прячем: иначе они в каждом куске. */
const HIDE_FIXED = `(() => {
  const hidden = []
  for (const el of document.querySelectorAll('body *')) {
    const p = getComputedStyle(el).position
    if (p === 'fixed' || p === 'sticky') { hidden.push([el, el.style.visibility]); el.style.visibility = 'hidden' }
  }
  window.__cnvCaptureHidden = hidden
  return hidden.length
})()`
const SHOW_FIXED = `(() => {
  for (const [el, v] of window.__cnvCaptureHidden || []) el.style.visibility = v
  delete window.__cnvCaptureHidden
})()`

/** Полосы прокрутки в снимок не нужны и съедают ширину вёрстки. */
const HIDE_SCROLLBARS = `(() => {
  const s = document.createElement('style')
  s.id = '__cnv-capture'
  s.textContent = '::-webkit-scrollbar{display:none!important}html,body{scrollbar-width:none!important}'
  document.documentElement.appendChild(s)
})()`
const SHOW_SCROLLBARS = `document.getElementById('__cnv-capture')?.remove()`

export async function captureWeb(guest: WebContents, opts: WebCaptureOptions = {}): Promise<string> {
  const dbg = guest.debugger
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')
  const send = <T>(method: string, params?: object): Promise<T> =>
    withTimeout(dbg.sendCommand(method, params) as Promise<T>, CAPTURE_TIMEOUT_MS, method)
  const evaluate = async <T>(expression: string): Promise<T> =>
    (
      await send<{ result: { value: T } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
    ).result.value

  const startScroll = await evaluate<number>('scrollY')
  let overridden = false
  let fixedHidden = false
  try {
    await evaluate(HIDE_SCROLLBARS)
    if (opts.width) {
      // Только ширина: высота и плотность пикселей остаются настоящими (0 — без подмены).
      const zoom = guest.getZoomFactor() || 1
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(opts.width * zoom),
        height: 0,
        deviceScaleFactor: 0,
        mobile: false
      })
      overridden = true
      await sleep(RELAYOUT_MS)
    }
    const view = await evaluate<{ w: number; h: number; page: number }>(
      '({ w: innerWidth, h: innerHeight, page: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })'
    )
    const total = opts.full ? Math.max(view.h, view.page) : view.h
    const tile = async (): Promise<NativeImage> => {
      const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      return nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
    }
    // Снимок — в CSS-пикселях: ширина картинки = ширина вёрстки, на любом экране.
    const toCss = (image: NativeImage): string => {
      const size = image.getSize()
      const out =
        Math.abs(size.width - view.w) > 1
          ? image.resize({
              width: Math.round(view.w),
              height: Math.round((size.height * view.w) / size.width),
              quality: 'best'
            })
          : image
      return out.toPNG().toString('base64')
    }
    if (!opts.full) return toCss(await tile())

    const parts: { y: number; image: NativeImage }[] = []
    for (let y = 0; y < total; y += view.h) {
      const at = await evaluate<number>(SCROLL(y))
      if (parts.length === 1 && !fixedHidden) {
        await evaluate(HIDE_FIXED)
        fixedHidden = true
        await evaluate(SCROLL(at))
      }
      parts.push({ y: at, image: await tile() })
      if (at < y - 1) break // упёрлись в низ страницы (прокрутка бывает дробной)
    }
    return toCss(stitch(parts, view.h, total))
  } finally {
    if (fixedHidden) await evaluate(SHOW_FIXED).catch(() => {})
    await evaluate(SHOW_SCROLLBARS).catch(() => {})
    await evaluate(SCROLL(startScroll)).catch(() => {})
    if (overridden) await dbg.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {})
    if (attachedHere && dbg.isAttached()) dbg.detach()
  }
}

/**
 * Склеить куски экранов в одну картинку. Куски — в пикселях устройства, позиции — в
 * CSS-пикселях: масштаб берём из высоты куска. Последний кусок обычно наезжает на
 * предыдущий (страница упёрлась в низ) — его верх уже нарисован, берём только новое.
 */
function stitch(
  parts: readonly { y: number; image: NativeImage }[],
  viewHeight: number,
  totalHeight: number
): NativeImage {
  const first = parts[0]!.image.getSize()
  const k = first.height / viewHeight
  const width = first.width
  const height = Math.min(MAX_HEIGHT, Math.round(totalHeight * k))
  const out = Buffer.alloc(width * height * 4)
  let filled = 0
  for (const { y, image } of parts) {
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const top = Math.round(y * k)
    for (let row = Math.max(filled, top); row < Math.min(height, top + size.height); row++) {
      const src = (row - top) * size.width * 4
      bitmap.copy(out, row * width * 4, src, src + Math.min(size.width, width) * 4)
      filled = row + 1
    }
  }
  return nativeImage.createFromBitmap(out, { width, height })
}
