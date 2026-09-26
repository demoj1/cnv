import { useEffect, type RefObject } from 'react'
import { screenToWorld } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { nodeRect, type DocNode } from '@core/document'
import { distanceToEdge, resolveEdges } from '@core/edges'
import { nearestSide, normalizeRect, type Point, type Rect } from '@core/geometry'
import { duplicateSubgraph, insertEdges, makeEdge, nodesInsideGroup, patchEdge, patchNodes } from '@core/ops'
import { snapCandidates, snapMove, snapResize, type Guide, type SnapSettings } from '@core/snapping'
import { marqueeSelect, resizeRect, type ResizeHandle } from '@core/transform'
import { imageAspect } from '@renderer/nodes/image-size'
import type { NodeSide } from '@shared/canvas'
import type { Settings } from '@shared/settings'

export interface MarqueeState {
  rect: Rect
  containedOnly: boolean
}

export interface EdgeDraft {
  from: Point
  to: Point
  targetId: string | null
}

interface Options {
  store: DocStore
  camera: CameraController
  settings: Settings
  nodeRefs: Map<string, HTMLElement>
  onMarquee(state: MarqueeState | null): void
  onGuides(guides: readonly Guide[]): void
  onHover(nodeId: string | null): void
  onEdgeDraft(draft: EdgeDraft | null): void
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
  | {
      kind: 'connect'
      pointerId: number
      anchor: Point
      sourceId: string
      sourceSide: NodeSide
      /** Задано, когда тащим конец существующего ребра. */
      edgeId: string | null
      end: 'from' | 'to'
    }

/** Клик считается попаданием по ребру в пределах этого расстояния в экранных пикселях. */
const EDGE_HIT_PX = 8

export function useCanvasInteractions(viewportRef: RefObject<HTMLElement | null>, options: Options): void {
  const { store, camera, settings, nodeRefs, onMarquee, onGuides, onHover, onEdgeDraft, onCreateTextAt } =
    options

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    let gesture: Gesture | null = null
    let frame = 0
    let pending: (() => void) | null = null
    let hovered: string | null = null

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

    const flush = (): void => {
      if (!frame) return
      cancelAnimationFrame(frame)
      frame = 0
      pending?.()
      pending = null
    }

    const worldAt = (e: { clientX: number; clientY: number }): Point => {
      const rect = el.getBoundingClientRect()
      return screenToWorld(camera.value, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    }

    const attr = (target: EventTarget | null, name: string): string | null =>
      (target as HTMLElement | null)?.closest?.(`[${name}]`)?.getAttribute(name) ?? null

    const snapSettings = (): SnapSettings => ({
      grid: settings.grid.snap,
      gridSize: settings.grid.size,
      smartGuides: settings.snapping.smartGuides,
      equalSpacing: settings.snapping.equalSpacing,
      thresholdPx: settings.snapping.thresholdPx,
      zoom: camera.value.zoom
    })

    const neighbours = (rect: Rect, exclude: ReadonlySet<string>): Rect[] =>
      snapCandidates(
        rect,
        store.doc.nodes.filter((n) => !exclude.has(n.id)).map(nodeRect),
        Math.max(rect.width, rect.height) * 2 + 400
      )

    const writeRect = (id: string, rect: Rect): void => {
      const node = nodeRefs.get(id)
      if (!node) return
      node.style.left = `${rect.x}px`
      node.style.top = `${rect.y}px`
      node.style.width = `${rect.width}px`
      node.style.height = `${rect.height}px`
    }

    const nodeAtPoint = (e: { clientX: number; clientY: number }): string | null =>
      attr(document.elementFromPoint(e.clientX, e.clientY), 'data-node-id')

    // Точка соединения лежит в оверлее и ноде не принадлежит: без этого наведение на
    // саму точку гасило бы hover и точка исчезала бы из-под курсора.
    const hoverTarget = (e: { clientX: number; clientY: number }): string | null => {
      const el2 = document.elementFromPoint(e.clientX, e.clientY)
      return attr(el2, 'data-node-id') ?? attr(el2, 'data-connect-node')
    }

    const edgeAt = (world: Point): string | null => {
      const limit = EDGE_HIT_PX / camera.value.zoom
      let best: { id: string; d: number } | null = null
      for (const { edge, geometry } of resolveEdges(store.doc)) {
        const d = distanceToEdge(geometry, world)
        if (d <= limit && (!best || d < best.d)) best = { id: edge.id, d }
      }
      return best?.id ?? null
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.defaultPrevented) return
      const state = store.snapshot

      const connectSide = attr(e.target, 'data-connect-side')
      if (connectSide) {
        const sourceId = attr(e.target, 'data-connect-node')
        if (!sourceId) return
        e.preventDefault()
        el.setPointerCapture(e.pointerId)
        gesture = {
          kind: 'connect',
          pointerId: e.pointerId,
          anchor: worldAt(e),
          sourceId,
          sourceSide: connectSide as NodeSide,
          edgeId: null,
          end: 'to'
        }
        return
      }

      const endpoint = attr(e.target, 'data-edge-endpoint')
      if (endpoint) {
        const edgeId = attr(e.target, 'data-edge-id')
        const edge = edgeId ? store.doc.edges.find((x) => x.id === edgeId) : undefined
        if (!edge) return
        e.preventDefault()
        el.setPointerCapture(e.pointerId)
        gesture = {
          kind: 'connect',
          pointerId: e.pointerId,
          anchor: worldAt(e),
          sourceId: endpoint === 'from' ? edge.toNode : edge.fromNode,
          sourceSide: (endpoint === 'from' ? edge.toSide : edge.fromSide) ?? 'right',
          edgeId: edge.id,
          end: endpoint === 'from' ? 'from' : 'to'
        }
        return
      }

      const handle = attr(e.target, 'data-resize-handle') as ResizeHandle | null
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
          // Пропорция — из самой картинки, а не из текущей рамки: рамка могла разъехаться.
          aspect: node.type === 'file' ? imageAspect(node.file) : null
        }
        return
      }

      const nodeId = attr(e.target, 'data-node-id')
      if (nodeId) {
        if (state.activeNodeId === nodeId) return
        e.preventDefault()
        const additive = e.shiftKey || e.ctrlKey || e.metaKey
        // Клик по ноде из группового выделения не сбрасывает его сразу — иначе нельзя
        // было бы утащить группу. Схлопываем до одной ноды, если drag не случился.
        const collapseOnClick = !additive && state.selection.size > 1 && state.selection.has(nodeId)
        if (additive) store.selectNodes([nodeId], 'toggle')
        else if (!state.selection.has(nodeId)) store.selectNodes([nodeId], 'replace')
        if (state.activeNodeId) store.setActiveNode(null)

        const selection = store.snapshot.selection
        if (!selection.has(nodeId)) return
        el.setPointerCapture(e.pointerId)

        // Группа тащит за собой ноды, целиком лежащие внутри неё (ТЗ 6.4).
        const moving = new Set(selection)
        for (const id of selection) {
          const node = store.doc.nodes.find((n) => n.id === id)
          if (node?.type === 'group') for (const inner of nodesInsideGroup(store.doc, id)) moving.add(inner)
        }

        const origin = new Map<string, Point>()
        for (const n of store.doc.nodes) if (moving.has(n.id)) origin.set(n.id, { x: n.x, y: n.y })
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

      const world = worldAt(e)
      const hitEdge = edgeAt(world)
      if (hitEdge) {
        e.preventDefault()
        store.selectEdges([hitEdge], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
        return
      }

      if (state.activeNodeId) store.setActiveNode(null)
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      if (!additive) store.clearSelection()
      el.setPointerCapture(e.pointerId)
      gesture = { kind: 'marquee', pointerId: e.pointerId, start: world, additive }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!gesture) {
        const id = hoverTarget(e)
        if (id !== hovered) {
          hovered = id
          onHover(id)
        }
        return
      }
      if (e.pointerId !== gesture.pointerId) return
      const world = worldAt(e)

      if (gesture.kind === 'drag') {
        const g = gesture
        const raw = { x: world.x - g.start.x, y: world.y - g.start.y }
        if (!g.moved && (raw.x !== 0 || raw.y !== 0)) {
          g.moved = true
          if (e.altKey) duplicateOnDragStart(store, g.origin)
        }

        let delta = raw
        let guides: readonly Guide[] = []
        const anchorId = g.origin.has(g.nodeId) ? g.nodeId : [...g.origin.keys()][0]
        const anchorStart = anchorId ? g.origin.get(anchorId) : undefined
        const anchorNode = anchorId ? store.doc.nodes.find((n) => n.id === anchorId) : undefined
        if (!e.altKey && anchorStart && anchorNode) {
          const moved = {
            x: anchorStart.x + raw.x,
            y: anchorStart.y + raw.y,
            width: anchorNode.width,
            height: anchorNode.height
          }
          const snapped = snapMove(moved, neighbours(moved, new Set(g.origin.keys())), snapSettings())
          delta = { x: raw.x + snapped.delta.x, y: raw.y + snapped.delta.y }
          guides = snapped.guides
        }
        onGuides(guides)

        const next = new Map<string, Partial<DocNode>>()
        for (const [id, p] of g.origin) {
          const x = p.x + delta.x
          const y = p.y + delta.y
          const target = nodeRefs.get(id)
          if (target) {
            target.style.left = `${x}px`
            target.style.top = `${y}px`
          }
          next.set(id, { x, y })
        }
        schedule(() => store.mutate('перемещение', (doc) => patchNodes(doc, next)))
        return
      }

      if (gesture.kind === 'resize') {
        const g = gesture
        const delta = { x: world.x - g.start.x, y: world.y - g.start.y }
        let rect = resizeRect(g.origin, g.handle, delta, {
          minSize: settings.nodes.minSize,
          aspectRatio: e.shiftKey ? null : g.aspect,
          fromCenter: e.altKey
        })
        if (e.altKey) {
          onGuides([])
        } else {
          const snapped = snapResize(rect, g.handle, neighbours(rect, new Set([g.nodeId])), snapSettings())
          rect = snapped.rect
          onGuides(snapped.guides)
        }
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

      if (gesture.kind === 'connect') {
        const g = gesture
        const targetId = nodeAtPoint(e)
        onEdgeDraft({
          from: g.anchor,
          to: world,
          targetId: targetId && targetId !== g.sourceId ? targetId : null
        })
        return
      }

      onMarquee({ rect: normalizeRect(gesture.start, world), containedOnly: e.altKey })
    }

    const finish = (e: PointerEvent): void => {
      if (!gesture || e.pointerId !== gesture.pointerId) return
      const g = gesture
      gesture = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      flush()
      onGuides([])

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

      if (g.kind === 'connect') {
        onEdgeDraft(null)
        const targetId = nodeAtPoint(e)
        if (!targetId || targetId === g.sourceId) return
        const target = store.doc.nodes.find((n) => n.id === targetId)
        if (!target) return
        const side = nearestSide(nodeRect(target), worldAt(e))
        const edgeId = g.edgeId
        if (edgeId) {
          store.mutate('переподключение ребра', (doc) =>
            patchEdge(
              doc,
              edgeId,
              g.end === 'from' ? { fromNode: targetId, fromSide: side } : { toNode: targetId, toSide: side }
            )
          )
          return
        }
        store.mutate('новое ребро', (doc) =>
          insertEdges(doc, [makeEdge(g.sourceId, targetId, { fromSide: g.sourceSide, toSide: side })])
        )
        return
      }

      store.commit()
      if (g.kind === 'drag' && !g.moved && g.collapseOnClick) store.selectNodes([g.nodeId], 'replace')
    }

    const onDoubleClick = (e: MouseEvent): void => {
      // e.target у click/dblclick схлопывается до общего предка, потому что pointerdown
      // забирает pointer capture на вьюпорт. Ноду ищем по координатам.
      const nodeId = nodeAtPoint(e)
      if (nodeId) {
        store.setActiveNode(nodeId)
        return
      }
      onCreateTextAt(worldAt(e))
    }

    const onPointerLeave = (): void => {
      if (gesture) return
      hovered = null
      onHover(null)
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
    el.addEventListener('pointerleave', onPointerLeave)
    el.addEventListener('dblclick', onDoubleClick)

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', finish)
      el.removeEventListener('pointercancel', finish)
      el.removeEventListener('pointerleave', onPointerLeave)
      el.removeEventListener('dblclick', onDoubleClick)
      if (frame) cancelAnimationFrame(frame)
      if (store.inTransaction) store.abort()
    }
  }, [
    viewportRef,
    store,
    camera,
    settings,
    nodeRefs,
    onMarquee,
    onGuides,
    onHover,
    onEdgeDraft,
    onCreateTextAt
  ])
}

/** Alt+drag: тащим копии, оригиналы остаются на месте. */
function duplicateOnDragStart(store: DocStore, origin: Map<string, Point>): void {
  const ids = new Set(origin.keys())
  const { doc, newNodeIds } = duplicateSubgraph(store.doc, ids, { x: 0, y: 0 })
  store.mutate('дублирование', () => doc)
  origin.clear()
  const fresh = new Set(newNodeIds)
  for (const n of doc.nodes) if (fresh.has(n.id)) origin.set(n.id, { x: n.x, y: n.y })
  store.selectNodes(newNodeIds, 'replace')
}
