import { useLayoutEffect, useRef } from 'react'
import { worldToScreen, worldRectToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type CanvasDoc, type DocNode } from '@core/document'
import { resolveEdges } from '@core/edges'
import { sideAnchor, unionRects, type Point, type Rect } from '@core/geometry'
import { NODE_SIDES } from '@shared/canvas'
import type { Guide } from '@core/snapping'
import { RESIZE_HANDLES, handleCursor, handlePosition } from '@core/transform'
import { nodeKind } from '@core/node-kind'
import type { EdgeDraft, MarqueeState } from './useCanvasInteractions'

interface Props {
  camera: CameraController
  doc: CanvasDoc
  selection: ReadonlySet<string>
  edgeSelection: ReadonlySet<string>
  hoveredId: string | null
  activeNodeId: string | null
  marquee: MarqueeState | null
  guides: readonly Guide[]
  draft: EdgeDraft | null
}

const place = (el: HTMLElement | SVGElement | null, r: Rect): void => {
  if (!(el instanceof HTMLElement)) return
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.width}px`
  el.style.height = `${r.height}px`
}

const GUIDE_THICKNESS = 2

const dot = (el: HTMLElement | null, p: Point): void => {
  if (!el) return
  el.style.left = `${p.x}px`
  el.style.top = `${p.y}px`
}

export function InteractionOverlay({
  camera,
  doc,
  selection,
  edgeSelection,
  hoveredId,
  activeNodeId,
  marquee,
  guides,
  draft
}: Props): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)

  const selected = doc.nodes.filter((n) => selection.has(n.id))
  const bounds = unionRects(selected.map(nodeRect))
  const single = selected.length === 1 ? selected[0] : null
  // У картинки бока не нужны: тянуть её можно только пропорционально, за угол.
  const handles =
    single && nodeKind(single) === 'image' ? RESIZE_HANDLES.filter((h) => h.length === 2) : RESIZE_HANDLES
  const connectTarget: DocNode | undefined =
    !activeNodeId && !marquee ? (doc.nodes.find((n) => n.id === hoveredId) ?? single ?? undefined) : undefined
  const selectedEdges = resolveEdges(doc).filter((e) => edgeSelection.has(e.edge.id))

  useLayoutEffect(() => {
    const host = root.current
    if (!host) return

    const paint = (cam: Camera): void => {
      if (bounds) place(host.querySelector<HTMLElement>('.sel-box'), worldRectToScreen(cam, bounds))
      if (marquee) place(host.querySelector<HTMLElement>('.marquee'), worldRectToScreen(cam, marquee.rect))

      if (single) {
        const rect = nodeRect(single)
        for (const el of host.querySelectorAll<HTMLElement>('[data-resize-handle]')) {
          const handle = el.dataset.resizeHandle
          if (!handle) continue
          dot(el, worldToScreen(cam, handlePosition(rect, handle as (typeof RESIZE_HANDLES)[number])))
        }
      }

      if (connectTarget) {
        const rect = nodeRect(connectTarget)
        for (const el of host.querySelectorAll<HTMLElement>('[data-connect-side]')) {
          const side = el.dataset.connectSide
          if (!side) continue
          dot(el, worldToScreen(cam, sideAnchor(rect, side as (typeof NODE_SIDES)[number])))
        }
      }

      for (const el of host.querySelectorAll<HTMLElement>('[data-guide-index]')) {
        const guide = guides[Number(el.dataset.guideIndex)]
        if (!guide) continue
        const a = worldToScreen(cam, { x: guide.position, y: guide.from })
        const b = worldToScreen(cam, { x: guide.position, y: guide.to })
        // Толщина в экранных пикселях и не зависит от zoom (ТЗ 3.4).
        if (guide.axis === 'x') {
          el.style.left = `${a.x - GUIDE_THICKNESS / 2}px`
          el.style.top = `${Math.min(a.y, b.y)}px`
          el.style.width = `${GUIDE_THICKNESS}px`
          el.style.height = `${Math.abs(b.y - a.y)}px`
        } else {
          const c = worldToScreen(cam, { x: guide.from, y: guide.position })
          const d = worldToScreen(cam, { x: guide.to, y: guide.position })
          el.style.left = `${Math.min(c.x, d.x)}px`
          el.style.top = `${c.y - GUIDE_THICKNESS / 2}px`
          el.style.width = `${Math.abs(d.x - c.x)}px`
          el.style.height = `${GUIDE_THICKNESS}px`
        }
      }

      for (const el of host.querySelectorAll<HTMLElement>('[data-edge-endpoint]')) {
        const x = Number(el.dataset.worldX)
        const y = Number(el.dataset.worldY)
        dot(el, worldToScreen(cam, { x, y }))
      }

      const line = host.querySelector<SVGLineElement>('.draft-line')
      if (line && draft) {
        const a = worldToScreen(cam, draft.from)
        const b = worldToScreen(cam, draft.to)
        line.setAttribute('x1', String(a.x))
        line.setAttribute('y1', String(a.y))
        line.setAttribute('x2', String(b.x))
        line.setAttribute('y2', String(b.y))
      }
    }

    paint(camera.value)
    return camera.subscribeRaw(paint)
  }, [camera, bounds, marquee, single, connectTarget, guides, draft, selectedEdges.length])

  return (
    <div className="overlay" ref={root}>
      {bounds && <div className="sel-box" />}
      {single &&
        handles.map((h) => (
          <div key={h} className="sel-handle" data-resize-handle={h} style={{ cursor: handleCursor(h) }} />
        ))}
      {connectTarget &&
        NODE_SIDES.map((side) => (
          <div
            key={side}
            className="connect-dot"
            data-connect-side={side}
            data-connect-node={connectTarget.id}
            title="Потяни, чтобы соединить"
          />
        ))}
      {guides.map((g, i) => (
        <div key={`${g.axis}-${g.position}-${i}`} className={`guide guide--${g.kind}`} data-guide-index={i} />
      ))}
      {selectedEdges.map(({ edge, geometry }) => (
        <div key={edge.id}>
          <div
            className="edge-endpoint"
            data-edge-endpoint="from"
            data-edge-id={edge.id}
            data-world-x={geometry.from.x}
            data-world-y={geometry.from.y}
          />
          <div
            className="edge-endpoint"
            data-edge-endpoint="to"
            data-edge-id={edge.id}
            data-world-x={geometry.to.x}
            data-world-y={geometry.to.y}
          />
        </div>
      ))}
      {draft && (
        <svg className="draft">
          <line className={draft.targetId ? 'draft-line draft-line--hit' : 'draft-line'} />
        </svg>
      )}
      {marquee && <div className="marquee" />}
    </div>
  )
}
