import { useLayoutEffect, useRef } from 'react'
import { worldToScreen, worldRectToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type CanvasDoc, type DocNode } from '@core/document'
import { resolveEdges } from '@core/edges'
import { rectCenter, rotateAround, sideAnchor, unionRects, type Point, type Rect } from '@core/geometry'
import { NODE_SIDES } from '@shared/canvas'
import type { Guide } from '@core/snapping'
import { RESIZE_HANDLES, handleCursor, handlePosition, type ResizeHandle } from '@core/transform'
import { nodeKind } from '@core/node-kind'
import { isRotatable, nodeRotate, visualBounds } from '@core/image-edit'
import type { EdgeDraft, MarqueeState } from './useCanvasInteractions'

interface Props {
  camera: CameraController
  doc: CanvasDoc
  selection: ReadonlySet<string>
  edgeSelection: ReadonlySet<string>
  hoveredId: string | null
  activeNodeId: string | null
  marquee: MarqueeState | null
  autoSides: boolean
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

/** Толщина боковой зоны захвата и отступ её концов от углов — в экранных пикселях. */
const EDGE_GRAB = 10
const EDGE_INSET = 9

/** Отступ кружка-гизмо поворота от верхнего края картинки — в экранных пикселях. */
const GIZMO_GAP = 26

/** Полоса захвата вдоль одной стороны бокса (в экранных координатах). */
function edgeBar(box: Rect, side: ResizeHandle): Rect {
  const half = EDGE_GRAB / 2
  const innerW = Math.max(0, box.width - 2 * EDGE_INSET)
  const innerH = Math.max(0, box.height - 2 * EDGE_INSET)
  switch (side) {
    case 'n':
      return { x: box.x + EDGE_INSET, y: box.y - half, width: innerW, height: EDGE_GRAB }
    case 's':
      return { x: box.x + EDGE_INSET, y: box.y + box.height - half, width: innerW, height: EDGE_GRAB }
    case 'w':
      return { x: box.x - half, y: box.y + EDGE_INSET, width: EDGE_GRAB, height: innerH }
    default:
      return { x: box.x + box.width - half, y: box.y + EDGE_INSET, width: EDGE_GRAB, height: innerH }
  }
}

export function InteractionOverlay({
  camera,
  doc,
  selection,
  edgeSelection,
  hoveredId,
  activeNodeId,
  marquee,
  autoSides,
  guides,
  draft
}: Props): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)

  const selected = doc.nodes.filter((n) => selection.has(n.id))
  const bounds = unionRects(selected.map(nodeRect))
  const single = selected.length === 1 ? selected[0] : null
  const isImage = single != null && nodeKind(single) === 'image'
  const rotatable = single != null && isRotatable(single)
  // Поворот крутит и рамку, и ручки, и гизмо вместе с нодой (Model A).
  const imageRotate = rotatable ? nodeRotate(single) : 0
  // У картинки — только углы (пропорция). Повёрнутую ноду тоже тянем за углы: повёрнутые
  // боковые полосы захвата пока не делаем.
  const handles =
    isImage || imageRotate !== 0 ? RESIZE_HANDLES.filter((h) => h.length === 2) : RESIZE_HANDLES
  const connectTarget: DocNode | undefined =
    !activeNodeId && !marquee ? (doc.nodes.find((n) => n.id === hoveredId) ?? single ?? undefined) : undefined
  const selectedEdges = resolveEdges(doc, autoSides).filter((e) => edgeSelection.has(e.edge.id))

  useLayoutEffect(() => {
    const host = root.current
    if (!host) return

    const paint = (cam: Camera): void => {
      if (bounds) {
        const selBox = host.querySelector<HTMLElement>('.sel-box')
        place(selBox, worldRectToScreen(cam, bounds))
        // Рамка повёрнутой картинки крутится вокруг своего центра вслед за самой картинкой.
        if (selBox) selBox.style.transform = imageRotate ? `rotate(${imageRotate}deg)` : ''
      }
      if (marquee) place(host.querySelector<HTMLElement>('.marquee'), worldRectToScreen(cam, marquee.rect))

      if (single) {
        const rect = nodeRect(single)
        const center = rectCenter(rect)
        const box = worldRectToScreen(cam, rect)
        for (const el of host.querySelectorAll<HTMLElement>('[data-resize-handle]')) {
          const handle = el.dataset.resizeHandle
          if (!handle) continue
          // Углы — точки. Бока — полосы во всю сторону, чтобы тянуть за любой её край, а
          // не за одну точку. Отступ от углов оставляет угловые точки за собой.
          if (handle.length === 2) {
            // rotateAround с нулевым углом не двигает точку — для неповёрнутых нод это no-op.
            const corner = rotateAround(
              handlePosition(rect, handle as (typeof RESIZE_HANDLES)[number]),
              center,
              imageRotate
            )
            dot(el, worldToScreen(cam, corner))
          } else {
            place(el, edgeBar(box, handle as ResizeHandle))
          }
        }

        const gizmo = host.querySelector<HTMLElement>('.rotate-gizmo')
        if (gizmo) {
          const topMid = rotateAround({ x: center.x, y: rect.y }, center, imageRotate)
          const s = worldToScreen(cam, topMid)
          // Отступаем наружу по повёрнутой «вверх»-нормали на постоянное число экранных px.
          const up = rotateAround({ x: 0, y: -1 }, { x: 0, y: 0 }, imageRotate)
          dot(gizmo, { x: s.x + up.x * GIZMO_GAP, y: s.y + up.y * GIZMO_GAP })
        }
      }

      if (connectTarget) {
        const rect = visualBounds(connectTarget)
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
  }, [camera, bounds, marquee, single, rotatable, imageRotate, connectTarget, guides, draft, selectedEdges.length])

  return (
    <div className="overlay" ref={root}>
      {bounds && <div className="sel-box" />}
      {single &&
        handles.map((h) => (
          <div
            key={h}
            className={h.length === 2 ? 'sel-handle sel-handle--corner' : 'sel-handle sel-handle--edge'}
            data-resize-handle={h}
            style={{ cursor: handleCursor(h) }}
          />
        ))}
      {rotatable && <div className="rotate-gizmo" data-rotate-handle="true" title="Повернуть" />}
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
