import { useLayoutEffect, useRef } from 'react'
import { worldRectToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { unionRects, type Rect } from '@core/geometry'
import { RESIZE_HANDLES, handleCursor, handlePosition } from '@core/transform'
import type { MarqueeState } from './useCanvasInteractions'

interface Props {
  camera: CameraController
  nodes: readonly DocNode[]
  selection: ReadonlySet<string>
  marquee: MarqueeState | null
}

const styleRect = (el: HTMLElement | null, r: Rect): void => {
  if (!el) return
  el.style.left = `${r.x}px`
  el.style.top = `${r.y}px`
  el.style.width = `${r.width}px`
  el.style.height = `${r.height}px`
}

export function SelectionOverlay({ camera, nodes, selection, marquee }: Props): React.JSX.Element | null {
  const boxRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<HTMLDivElement>(null)

  const selected = nodes.filter((n) => selection.has(n.id))
  const bounds = unionRects(selected.map(nodeRect))
  const single = selected.length === 1 ? selected[0] : null

  useLayoutEffect(() => {
    const paint = (cam: Camera): void => {
      if (bounds) styleRect(boxRef.current, worldRectToScreen(cam, bounds))
      if (marquee) styleRect(marqueeRef.current, worldRectToScreen(cam, marquee.rect))
      const host = handlesRef.current
      if (host && single) {
        const rect = nodeRect(single)
        for (const el of host.children) {
          const handle = (el as HTMLElement).dataset.resizeHandle
          if (!handle) continue
          const p = handlePosition(rect, handle as (typeof RESIZE_HANDLES)[number])
          const screen = worldRectToScreen(cam, { x: p.x, y: p.y, width: 0, height: 0 })
          ;(el as HTMLElement).style.left = `${screen.x}px`
          ;(el as HTMLElement).style.top = `${screen.y}px`
        }
      }
    }
    paint(camera.value)
    return camera.subscribeRaw(paint)
  }, [camera, bounds, marquee, single])

  if (!bounds && !marquee) return null

  return (
    <>
      {bounds && <div className="sel-box" ref={boxRef} />}
      {single && (
        <div className="sel-handles" ref={handlesRef}>
          {RESIZE_HANDLES.map((h) => (
            <div key={h} className="sel-handle" data-resize-handle={h} style={{ cursor: handleCursor(h) }} />
          ))}
        </div>
      )}
      {marquee && <div className="marquee" ref={marqueeRef} />}
    </>
  )
}
