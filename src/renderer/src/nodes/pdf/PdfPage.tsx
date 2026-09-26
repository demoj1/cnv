import { useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PdfDocument } from './pdfjs'

interface Props {
  doc: PdfDocument
  pageNumber: number
  /** Ширина, в которую вписываем страницу, в CSS-пикселях мира. */
  width: number
  /** Во сколько раз мир увеличен камерой — от этого зависит разрешение растра. */
  renderScale: number
  withText: boolean
  onSize?(size: { width: number; height: number }): void
}

/** Выше этого растр стоит дороже, чем выигрыш в чёткости (спайк: scale 3 → ~1 с). */
const MAX_RENDER_SCALE = 2.5

export function PdfPage({ doc, pageNumber, width, renderScale, withText, onSize }: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let task: { cancel(): void } | null = null

    const run = async (): Promise<void> => {
      const canvas = canvasRef.current
      if (!canvas) return
      try {
        const page = await doc.getPage(pageNumber)
        if (cancelled) return

        const base = page.getViewport({ scale: 1 })
        const fit = width / base.width
        const viewport = page.getViewport({ scale: fit })
        const raster = Math.min(renderScale * window.devicePixelRatio, MAX_RENDER_SCALE)
        const rasterViewport = page.getViewport({ scale: fit * raster })

        canvas.width = Math.ceil(rasterViewport.width)
        canvas.height = Math.ceil(rasterViewport.height)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        setHeight(viewport.height)
        onSize?.({ width: viewport.width, height: viewport.height })

        const context = canvas.getContext('2d')
        if (!context) return
        const render = page.render({ canvas, canvasContext: context, viewport: rasterViewport })
        task = render
        await render.promise
        if (cancelled) return

        const textHost = textRef.current
        if (withText && textHost) {
          textHost.replaceChildren()
          textHost.style.width = `${viewport.width}px`
          textHost.style.height = `${viewport.height}px`
          const layer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textHost,
            viewport
          })
          await layer.render()
        }
        setFailed(null)
      } catch (e) {
        if (cancelled) return
        // Отмена перерендера — это не ошибка страницы.
        const message = e instanceof Error ? e.message : String(e)
        if (!/cancel/i.test(message)) setFailed(message)
      }
    }

    void run()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber, width, renderScale, withText, onSize])

  return (
    <div className="pdf-page" style={{ width: `${width}px`, height: height ? `${height}px` : undefined }}>
      <canvas className="pdf-page__canvas" ref={canvasRef} />
      {withText && <div className="pdf-page__text" ref={textRef} />}
      {failed && (
        <div className="pdf-page__error">
          Страница {pageNumber}: {failed}
        </div>
      )}
    </div>
  )
}
