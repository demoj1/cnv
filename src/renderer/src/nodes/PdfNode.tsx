import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import { clamp } from '@core/geometry'
import { useCanvasEnv } from '@renderer/canvas/env'
import { PdfPage } from './pdf/PdfPage'
import { usePdfDocument } from './pdf/usePdfDocument'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

/** Перерендер под новый zoom — только после остановки камеры. */
const ZOOM_SETTLE_MS = 250
const PAGE_GAP = 12

export function PdfNodeView({ node, active }: Props): React.JSX.Element {
  const { camera, viewState } = useCanvasEnv()
  const [reloadToken, setReloadToken] = useState(0)
  const { doc, pages, error } = usePdfDocument(window.api.files.url(node.file), reloadToken)

  const saved = viewState.get(node.id).pdfPage
  const [page, setPage] = useState(saved && saved > 0 ? saved : 1)
  const [renderScale, setRenderScale] = useState(camera.value.zoom)
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(new Set([page]))
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    return camera.subscribeFrame((cam) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setRenderScale(cam.zoom), ZOOM_SETTLE_MS)
    })
  }, [camera])

  const goto = useCallback(
    (next: number) => {
      const target = clamp(Math.round(next), 1, Math.max(pages, 1))
      setPage(target)
      viewState.patch(node.id, { pdfPage: target })
      const host = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`)
      host?.scrollIntoView({ block: 'start' })
    },
    [pages, node.id, viewState]
  )

  // Что рендерить: видимые страницы с запасом.
  useEffect(() => {
    if (!active || !doc) return
    const host = scrollRef.current
    if (!host) return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page)
            if (!n) continue
            if (e.isIntersecting) next.add(n)
            else next.delete(n)
          }
          return next
        })
      },
      { root: host, rootMargin: '300px 0px' }
    )
    for (const el of host.querySelectorAll('[data-page]')) observer.observe(el)
    return () => observer.disconnect()
  }, [active, doc, pages])

  // Какая страница считается текущей: та, что накрывает верх окна прокрутки.
  useEffect(() => {
    if (!active || !doc) return
    const host = scrollRef.current
    if (!host) return
    let frame = 0
    const update = (): void => {
      frame = 0
      const top = host.scrollTop
      let current = 1
      for (const el of host.querySelectorAll<HTMLElement>('[data-page]')) {
        if (el.offsetTop - host.offsetTop > top + 4) break
        current = Number(el.dataset.page) || current
      }
      setPage(current)
      viewState.patch(node.id, { pdfPage: current })
    }
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      host.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [active, doc, node.id, viewState])

  const width = node.width - 2

  if (error) {
    return (
      <div className="node-error">
        <div className="node-error__title">PDF не открылся</div>
        <div className="node-error__detail">{error}</div>
        <button type="button" onClick={() => setReloadToken((v) => v + 1)}>
          Повторить
        </button>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="node-file">
        <div className="node-file__name">{node.file.split('/').pop()}</div>
        <div className="node-error__detail">загружается…</div>
      </div>
    )
  }

  if (!active) {
    return (
      <div className="node-pdf">
        <div className="node-pdf__single">
          <PdfPage doc={doc} pageNumber={page} width={width} renderScale={renderScale} withText={false} />
        </div>
        <div className="node-pdf__badge">
          {page} / {pages}
        </div>
      </div>
    )
  }

  return (
    <div className="node-pdf node-pdf--active">
      <div className="node-pdf__bar">
        <button type="button" title="Предыдущая" disabled={page <= 1} onClick={() => goto(page - 1)}>
          ‹
        </button>
        <input
          className="node-pdf__page"
          value={page}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ''))
            if (n) goto(n)
          }}
        />
        <span className="node-pdf__total">/ {pages}</span>
        <button type="button" title="Следующая" disabled={page >= pages} onClick={() => goto(page + 1)}>
          ›
        </button>
        <button
          type="button"
          title="Открыть в системе"
          onClick={() => void window.api.files.openInSystem(node.file)}
        >
          ↗
        </button>
      </div>
      <div className="node-pdf__scroll" ref={scrollRef}>
        {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
          <div className="node-pdf__slot" key={n} data-page={n} style={{ marginBottom: PAGE_GAP }}>
            {visiblePages.has(n) ? (
              <PdfPage doc={doc} pageNumber={n} width={width} renderScale={renderScale} withText />
            ) : (
              <div className="node-pdf__placeholder" style={{ width }} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
