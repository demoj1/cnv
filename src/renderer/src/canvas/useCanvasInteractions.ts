import { useEffect, type RefObject } from 'react'
import { screenToWorld } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { nodeRect, type DocNode } from '@core/document'
import { normalizeRect, type Point, type Rect } from '@core/geometry'
import { duplicateSubgraph, patchNodes } from '@core/ops'
import { marqueeSelect, resizeRect, type ResizeHandle } from '@core/transform'
import type { Settings } from '@shared/settings'

export interface MarqueeState {
  rect: Rect
  containedOnly: boolean
}

interface Options {
  store: DocStore
  camera: CameraController
  settings: Settings
  nodeRefs: Map<string, HTMLElement>
  onMarquee(state: MarqueeState | null): void
  onCreateTextAt(world: Point): void
}

type Gesture =
  | {
      kind: 'drag'
      pointerId: number
      start: Point
      origin: Map<string, Point>
      moved: boolean
      nodeId: string
      collapseOnClick: boolean
    }
  | {
      kind: 'resize'
      pointerId: number
      start: Point
      handle: ResizeHandle
      nodeId: string
      origin: Rect
      aspect: number | null
    }
  | { kind: 'marquee'; pointerId: number; start: Point; additive: boolean }

export function useCanvasInteractions(viewportRef: RefObject<HTMLElement | null>, options: Options): void {
  const { store, camera, settings, nodeRefs, onMarquee, onCreateTextAt } = options

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    let gesture: Gesture | null = null
    let frame = 0
    let pending: (() => void) | null = null

    const schedule = (fn: () => void): void => {
      pending = fn
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const run = pending
        pending = null
        run?.()
      })
    }

    const worldAt = (e: PointerEvent): Point => {
      const rect = el.getBoundingClientRect()
      return screenToWorld(camera.value, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    }

    const nodeIdAt = (target: EventTarget | null): string | null =>
      (target as HTMLElement | null)?.closest?.('[data-node-id]')?.getAttribute('data-node-id') ?? null

    const handleAt = (target: EventTarget | null): ResizeHandle | null =>
      ((target as HTMLElement | null)
        ?.closest?.('[data-resize-handle]')
        ?.getAttribute('data-resize-handle') ?? null) as ResizeHandle | null

    const writeRect = (id: string, rect: Rect): void => {
      const node = nodeRefs.get(id)
      if (!node) return
      node.style.left = `${rect.x}px`
      node.style.top = `${rect.y}px`
      node.style.width = `${rect.width}px`
      node.style.height = `${rect.height}px`
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.defaultPrevented) return
      const handle = handleAt(e.target)
      const state = store.snapshot

      if (handle) {
        const id = [...state.selection][0]
        const node = id ? state.doc.nodes.find((n) => n.id === id) : undefined
        if (!node) return
        e.preventDefault()
        el.setPointerCapture(e.pointerId)
        store.begin('изменение размера')
        gesture = {
          kind: 'resize',
          pointerId: e.pointerId,
          start: worldAt(e),
          handle,
          nodeId: node.id,
          origin: nodeRect(node),
          aspect: keepAspect(node, settings)
        }
        return
      }

      const nodeId = nodeIdAt(e.target)
      if (nodeId) {
        if (state.activeNodeId === nodeId) return
        e.preventDefault()
        const additive = e.shiftKey || e.ctrlKey || e.metaKey
        // Клик по ноде из группового выделения не сбрасывает его сразу — иначе нельзя
        // было бы тащить всю группу. Схлопываем до одной ноды, если drag не случился.
        const collapseOnClick = !additive && state.selection.size > 1 && state.selection.has(nodeId)
        if (additive) store.selectNodes([nodeId], 'toggle')
        else if (!state.selection.has(nodeId)) store.selectNodes([nodeId], 'replace')
        if (state.activeNodeId) store.setActiveNode(null)

        const selection = store.snapshot.selection
        if (!selection.has(nodeId)) return
        el.setPointerCapture(e.pointerId)
        const origin = new Map<string, Point>()
        for (const n of store.doc.nodes) if (selection.has(n.id)) origin.set(n.id, { x: n.x, y: n.y })
        store.begin('перемещение')
        gesture = {
          kind: 'drag',
          pointerId: e.pointerId,
          start: worldAt(e),
          origin,
          moved: false,
          nodeId,
          collapseOnClick
        }
        return
      }

      if (store.snapshot.activeNodeId) store.setActiveNode(null)
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      if (!additive) store.clearSelection()
      el.setPointerCapture(e.pointerId)
      gesture = { kind: 'marquee', pointerId: e.pointerId, start: worldAt(e), additive }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!gesture || e.pointerId !== gesture.pointerId) return
      const world = worldAt(e)

      if (gesture.kind === 'drag') {
        const g = gesture
        const delta = { x: world.x - g.start.x, y: world.y - g.start.y }
        if (!g.moved && Math.hypot(delta.x, delta.y) > 0) {
          g.moved = true
          if (e.altKey) duplicateOnDragStart(store, g.origin)
        }
        const next = new Map<string, Partial<DocNode>>()
        for (const [id, p] of g.origin) {
          const rect = { x: p.x + delta.x, y: p.y + delta.y, width: 0, height: 0 }
          const el2 = nodeRefs.get(id)
          if (el2) {
            el2.style.left = `${rect.x}px`
            el2.style.top = `${rect.y}px`
          }
          next.set(id, { x: rect.x, y: rect.y })
        }
        schedule(() => store.mutate('перемещение', (doc) => patchNodes(doc, next)))
        return
      }

      if (gesture.kind === 'resize') {
        const g = gesture
        const delta = { x: world.x - g.start.x, y: world.y - g.start.y }
        const rect = resizeRect(g.origin, g.handle, delta, {
          minSize: settings.nodes.minSize,
          aspectRatio: e.shiftKey ? null : g.aspect,
          fromCenter: e.altKey
        })
        writeRect(g.nodeId, rect)
        schedule(() =>
          store.mutate('изменение размера', (doc) =>
            patchNodes(
              doc,
              new Map([[g.nodeId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }]])
            )
          )
        )
        return
      }

      const box = normalizeRect(gesture.start, world)
      onMarquee({ rect: box, containedOnly: e.altKey })
    }

    const finish = (e: PointerEvent): void => {
      if (!gesture || e.pointerId !== gesture.pointerId) return
      const g = gesture
      gesture = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
        pending?.()
        pending = null
      }

      if (g.kind === 'marquee') {
        const box = normalizeRect(g.start, worldAt(e))
        onMarquee(null)
        if (box.width < 1 && box.height < 1) return
        const hits = marqueeSelect(
          store.doc.nodes.map((n) => ({ id: n.id, rect: nodeRect(n) })),
          box,
          e.altKey
        )
        store.selectNodes(hits, g.additive ? 'add' : 'replace')
        return
      }

      store.commit()
      if (g.kind === 'drag' && !g.moved && g.collapseOnClick) store.selectNodes([g.nodeId], 'replace')
    }

    const onDoubleClick = (e: MouseEvent): void => {
      // e.target у click/dblclick схлопывается до общего предка, потому что pointerdown
      // забирает pointer capture на вьюпорт. Ноду ищем по координатам.
      const nodeId = nodeIdAt(document.elementFromPoint(e.clientX, e.clientY))
      if (nodeId) {
        store.setActiveNode(nodeId)
        return
      }
      const rect = el.getBoundingClientRect()
      onCreateTextAt(screenToWorld(camera.value, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
    el.addEventListener('dblclick', onDoubleClick)

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', finish)
      el.removeEventListener('pointercancel', finish)
      el.removeEventListener('dblclick', onDoubleClick)
      if (frame) cancelAnimationFrame(frame)
      if (store.inTransaction) store.abort()
    }
  }, [viewportRef, store, camera, settings, nodeRefs, onMarquee, onCreateTextAt])
}

function keepAspect(node: DocNode, settings: Settings): number | null {
  void settings
  return node.type === 'file' && /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i.test(node.file)
    ? node.width / Math.max(node.height, 1)
    : null
}

/** Alt+drag: тащим копии, оригиналы остаются на месте. */
function duplicateOnDragStart(store: DocStore, origin: Map<string, Point>): void {
  const ids = new Set(origin.keys())
  const { doc, newNodeIds } = duplicateSubgraph(store.doc, ids, { x: 0, y: 0 })
  store.mutate('дублирование', () => doc)
  origin.clear()
  const map = new Map(newNodeIds.map((id, i) => [id, i]))
  for (const n of doc.nodes) if (map.has(n.id)) origin.set(n.id, { x: n.x, y: n.y })
  store.selectNodes(newNodeIds, 'replace')
}
