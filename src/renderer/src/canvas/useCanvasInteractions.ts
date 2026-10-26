import { useEffect, type RefObject } from 'react'
import { screenToWorld } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { nodeRect, removeEntities, type DocNode } from '@core/document'
import { distanceToEdge, resolveEdges } from '@core/edges'
import { nearestSide, normalizeRect, type Point, type Rect } from '@core/geometry'
import {
  duplicateSubgraph,
  insertEdges,
  insertNodes,
  makeEdge,
  makeNode,
  nodesInsideGroup,
  patchEdge,
  patchNodes
} from '@core/ops'
import { snapCandidates, snapMove, snapResize, type Guide, type SnapSettings } from '@core/snapping'
import { marqueeSelect, resizeRect, resizeRotated, type ResizeHandle } from '@core/transform'
import {
  nodeRotate,
  normalizeAngle,
  snapAngle,
  visualBounds,
  withImageEdit,
  withRotate
} from '@core/image-edit'
import { nodeKind } from '@core/node-kind'
import { imageAspect } from '@renderer/nodes/image-size'
import type { NodeSide } from '@shared/canvas'
import type { Settings } from '@shared/settings'
import { applyNodePatch } from '@core/agent-ops'
import { boardSpec, findCard, isBoard } from '@core/board'
import type { CardTarget } from './env'
import { openNode } from './open-node'

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
  onCropImage(nodeId: string): void
  /** Двойной клик по группе — подпись группы. */
  onRenameGroup(nodeId: string): void
  /** Двойной клик по карточке доски — её редактор. */
  onEditCard(boardId: string, target: CardTarget): void
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
      /** Угол картинки (градусы); ≠0 переключает на повёрнутый ресайз без снапа. */
      angle: number
    }
  | {
      kind: 'rotate'
      pointerId: number
      nodeId: string
      center: Point
      /** Угол картинки в начале жеста (градусы). */
      startAngle: number
      /** Угол курсора относительно центра в начале жеста (градусы). */
      startPointer: number
    }
  | { kind: 'marquee'; pointerId: number; start: Point; additive: boolean }
  | {
      kind: 'card'
      pointerId: number
      boardId: string
      cardId: string
      start: Point
      moved: boolean
      card: HTMLElement
      ghost: HTMLElement | null
    }
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
  const {
    store,
    camera,
    settings,
    nodeRefs,
    onMarquee,
    onGuides,
    onHover,
    onEdgeDraft,
    onCreateTextAt,
    onCropImage,
    onRenameGroup,
    onEditCard
  } = options

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
        store.doc.nodes.filter((n) => !exclude.has(n.id)).map(visualBounds),
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
      for (const { edge, geometry } of resolveEdges(store.doc, settings.edges.autoSides)) {
        const d = distanceToEdge(geometry, world)
        if (d <= limit && (!best || d < best.d)) best = { id: edge.id, d }
      }
      return best?.id ?? null
    }

    /** Куда упадёт карточка: дорожка под курсором и место в ней. `skip` — тащимая нода. */
    const laneAt = (
      e: { clientX: number; clientY: number },
      skip?: string,
      cardId?: string
    ): {
      boardId: string
      laneId: string
      index: number
      lane: HTMLElement
      before: HTMLElement | null
    } | null => {
      for (const hit of document.elementsFromPoint(e.clientX, e.clientY)) {
        const lane = (hit as HTMLElement).closest?.<HTMLElement>('[data-board-lane]')
        if (!lane) continue
        const boardId = lane.dataset.boardId ?? ''
        if (!boardId || boardId === skip) continue
        const cards = [...lane.querySelectorAll<HTMLElement>('[data-board-card]')].filter(
          (c) => c.dataset.boardCard !== cardId
        )
        const at = cards.findIndex((c) => {
          const r = c.getBoundingClientRect()
          return r.top + r.height / 2 > e.clientY
        })
        return {
          boardId,
          laneId: lane.dataset.boardLane ?? '',
          index: at < 0 ? cards.length : at,
          lane,
          before: at < 0 ? null : (cards[at] ?? null)
        }
      }
      return null
    }

    let marked: HTMLElement[] = []
    const markDrop = (target: ReturnType<typeof laneAt>): void => {
      for (const m of marked)
        m.classList.remove('board-lane--over', 'board-card--drop-before', 'board-lane--drop-end')
      marked = []
      if (!target) return
      target.lane.classList.add('board-lane--over')
      marked.push(target.lane)
      if (target.before) {
        target.before.classList.add('board-card--drop-before')
        marked.push(target.before)
      } else target.lane.classList.add('board-lane--drop-end')
    }

    /** Обычная текстовая карточка холста — её можно встроить в доску. */
    const embeddable = (id: string): DocNode | null => {
      const node = store.doc.nodes.find((n) => n.id === id)
      return node && nodeKind(node) === 'text' ? node : null
    }

    /** Карточку доски отпустили: на дорожку (эту или чужую доску) или на холст. */
    const dropCard = (
      g: { boardId: string; cardId: string },
      target: ReturnType<typeof laneAt>,
      e: PointerEvent
    ): void => {
      const board = store.doc.nodes.find((n) => n.id === g.boardId)
      const spec = board ? boardSpec(board) : null
      if (!spec) return
      const { card, lane, index } = findCard(spec, g.cardId)
      if (target?.boardId === g.boardId) {
        if (target.laneId === lane.id && target.index === index) return
        store.mutate('карточка', (doc) =>
          applyNodePatch(doc, g.boardId, {
            board: { op: 'move_card', card: card.id, lane: target.laneId, index: target.index }
          })
        )
        return
      }
      if (target) {
        store.mutate('карточка на другую доску', (doc) =>
          applyNodePatch(
            applyNodePatch(doc, g.boardId, { board: { op: 'delete_card', card: card.id } }),
            target.boardId,
            {
              board: {
                op: 'add_card',
                lane: target.laneId,
                text: card.text,
                index: target.index,
                id: card.id,
                ...(card.color ? { color: card.color } : {})
              }
            }
          )
        )
        return
      }
      // Над самой доской, но мимо дорожек, — передумали.
      const over = nodeAtPoint(e)
      if (over && store.doc.nodes.some((n) => n.id === over && isBoard(n))) return
      const size = settings.nodes.defaultTextSize
      const at = worldAt(e)
      const node = makeNode(
        { type: 'text', text: card.text },
        { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - 20), ...size },
        card.color
      )
      store.mutate('карточка с доски', (doc) =>
        insertNodes(applyNodePatch(doc, g.boardId, { board: { op: 'delete_card', card: card.id } }), [node])
      )
      store.selectNodes([node.id], 'replace')
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.defaultPrevented) return
      // Кнопки и поля в шапках нод живут сами: захват указателя холстом съел бы их клик.
      if ((e.target as HTMLElement | null)?.closest?.('button, input, select, textarea')) return
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

      if (attr(e.target, 'data-rotate-handle')) {
        const id = [...state.selection][0]
        const node = id ? state.doc.nodes.find((n) => n.id === id) : undefined
        if (!node) return
        e.preventDefault()
        el.setPointerCapture(e.pointerId)
        store.begin('поворот')
        const rect = nodeRect(node)
        const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const w = worldAt(e)
        gesture = {
          kind: 'rotate',
          pointerId: e.pointerId,
          nodeId: node.id,
          center,
          startAngle: nodeRotate(node),
          startPointer: (Math.atan2(w.y - center.y, w.x - center.x) * 180) / Math.PI
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
          aspect: node.type === 'file' ? imageAspect(node.file) : null,
          angle: nodeRotate(node)
        }
        return
      }

      const cardEl = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-board-card]')
      const cardBoard = cardEl ? attr(cardEl, 'data-node-id') : null
      if (cardEl && cardBoard) {
        e.preventDefault()
        el.setPointerCapture(e.pointerId)
        gesture = {
          kind: 'card',
          pointerId: e.pointerId,
          boardId: cardBoard,
          cardId: cardEl.dataset.boardCard ?? '',
          start: { x: e.clientX, y: e.clientY },
          moved: false,
          card: cardEl,
          ghost: null
        }
        return
      }

      const nodeId = attr(e.target, 'data-node-id')
      // Группа — подложка: стрелки рисуются под нодами, и без этого стрелку внутри группы
      // не выбрать — клик забирает сама группа.
      if (nodeId && store.doc.nodes.find((n) => n.id === nodeId)?.type === 'group') {
        const hitEdge = edgeAt(worldAt(e))
        if (hitEdge) {
          e.preventDefault()
          store.selectEdges([hitEdge], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
          return
        }
      }
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

      if (gesture.kind === 'card') {
        const g = gesture
        if (!g.moved && Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 4) return
        if (!g.moved) {
          g.moved = true
          // Призрак — копия карточки под курсором, в масштабе холста.
          const ghost = g.card.cloneNode(true) as HTMLElement
          ghost.classList.add('board-ghost')
          ghost.style.width = `${g.card.offsetWidth}px`
          ghost.style.transform = `scale(${camera.value.zoom})`
          document.body.appendChild(ghost)
          g.ghost = ghost
          g.card.classList.add('board-card--dragging')
        }
        if (g.ghost) {
          g.ghost.style.left = `${e.clientX + 8}px`
          g.ghost.style.top = `${e.clientY + 8}px`
        }
        markDrop(laneAt(e, undefined, g.cardId))
        return
      }

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
        if (anchorStart && anchorNode) {
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
        markDrop(g.origin.size === 1 && embeddable(g.nodeId) ? laneAt(e, g.nodeId) : null)

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
        const opts = {
          minSize: settings.nodes.minSize,
          aspectRatio: e.shiftKey ? null : g.aspect,
          fromCenter: e.altKey
        }
        let rect: Rect
        if (g.angle) {
          // Повёрнутая картинка: ресайз в её локальной системе, снап по неповёрнутому
          // прямоугольнику врал бы — выключаем.
          rect = resizeRotated(g.origin, g.handle, delta, g.angle, opts)
          onGuides([])
        } else {
          rect = resizeRect(g.origin, g.handle, delta, opts)
          const snapped = snapResize(rect, g.handle, neighbours(rect, new Set([g.nodeId])), snapSettings())
          rect = snapped.rect
          onGuides(snapped.guides)
        }
        writeRect(g.nodeId, rect)
        schedule(() =>
          store.mutate('изменение размера', (doc) => {
            const n = doc.nodes.find((x) => x.id === g.nodeId)
            const patch: Partial<DocNode> = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            }
            // Ручной размер картинки — повод навсегда заглушить авто-подгонку высоты.
            if (n && nodeKind(n) === 'image') patch.extra = withImageEdit(n.extra, { sized: true })
            return patchNodes(doc, new Map([[g.nodeId, patch]]))
          })
        )
        return
      }

      if (gesture.kind === 'rotate') {
        const g = gesture
        const cur = (Math.atan2(world.y - g.center.y, world.x - g.center.x) * 180) / Math.PI
        let angle = g.startAngle + (cur - g.startPointer)
        if (e.shiftKey) angle = snapAngle(angle)
        angle = normalizeAngle(angle)
        // Прямой transform ноды — для плавности, как writeRect у ресайза.
        const target = nodeRefs.get(g.nodeId)
        if (target) target.style.transform = `rotate(${angle}deg)`
        schedule(() =>
          store.mutate('поворот', (doc) => {
            const n = doc.nodes.find((x) => x.id === g.nodeId)
            if (!n) return doc
            return patchNodes(doc, new Map([[g.nodeId, { extra: withRotate(n.extra, angle) }]]))
          })
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
          store.doc.nodes.map((n) => ({ id: n.id, rect: visualBounds(n) })),
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
        const side = nearestSide(visualBounds(target), worldAt(e))
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

      if (g.kind === 'card') {
        g.ghost?.remove()
        g.card.classList.remove('board-card--dragging')
        const target = laneAt(e, undefined, g.cardId)
        markDrop(null)
        if (g.moved) dropCard(g, target, e)
        return
      }

      if (g.kind === 'drag') {
        const target = g.moved && g.origin.size === 1 ? laneAt(e, g.nodeId) : null
        markDrop(null)
        const node = target ? embeddable(g.nodeId) : null
        if (target && node && node.type === 'text') {
          // Карточка холста встраивается в доску: нода уходит, на дорожке — её текст и цвет.
          store.mutate('карточка на доску', (doc) =>
            applyNodePatch(removeEntities(doc, new Set([node.id]), new Set()), target.boardId, {
              board: {
                op: 'add_card',
                lane: target.laneId,
                text: node.text,
                index: target.index,
                ...(node.color ? { color: node.color } : {})
              }
            })
          )
        }
      }

      store.commit()
      if (g.kind === 'drag' && !g.moved && g.collapseOnClick) store.selectNodes([g.nodeId], 'replace')
    }

    const onDoubleClick = (e: MouseEvent): void => {
      // e.target у click/dblclick схлопывается до общего предка, потому что pointerdown
      // забирает pointer capture на вьюпорт. Ноду ищем по координатам.
      const nodeId = nodeAtPoint(e)
      const cardEl = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-board-card]')
      if (nodeId && cardEl?.dataset.boardCard) {
        onEditCard(nodeId, { card: cardEl.dataset.boardCard })
        return
      }
      if (nodeId) {
        // Активна может быть только нода, которая умеет принимать мышь. «Активная
        // картинка» не значит ничего, а мышь над ней забирала бы — холст замирал.
        const node = store.doc.nodes.find((n) => n.id === nodeId)
        if (node) openNode(store, node, { onCropImage, onRenameGroup })
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
    onCreateTextAt,
    onCropImage,
    onRenameGroup,
    onEditCard
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
