import { useEffect, useRef, type RefObject } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { docBounds, nodeRect } from '@core/document'
import { rectsIntersect, unionRects } from '@core/geometry'
import { isTerminal } from '@core/terminal'
import {
  AgentOpError,
  applyEdgePatch,
  applyNodePatch,
  buildEdge,
  buildNode,
  defaultSize,
  placeRect,
  splitIds,
  toAgentEdge,
  toAgentNode
} from '@core/agent-ops'
import { isImageFile } from '@core/node-kind'
import { deleteEntities, insertEdges, insertNodes, nodesInsideGroup } from '@core/ops'
import { describeNamed, lookupTerminal, lookupWeb } from '@core/terminal-identity'
import { notFoundMessage } from '@core/name-match'
import { nodeName } from '@core/node-name'
import type { AgentMethod, AgentMethods, AgentNodeInit, AgentPlacement, AgentRequest } from '@shared/agent'
import type { CanvasColor } from '@shared/canvas'
import type { CanvasDoc, DocEdge, DocNode } from '@core/document'
import type { Settings } from '@shared/settings'
import type { CommandHandlers } from '../commands/useCommands'
import { readTerminalScreen, requestTerminalRestart } from '../nodes/terminal-registry'
import { pulseEdge, pulseGhost } from '../canvas/edge-pulses'
import type { WebRuntime } from '../web/context'
import type { DesktopsApi } from './useDesktops'
import { visibleWorldRect } from '@core/camera'
import { isDesktop, moveToDesktop } from '@core/desktops'

/** Картинку агента без размеров вписываем в такой квадрат, сохраняя пропорции. */
const IMAGE_MAX_SIDE = 600

/** Кто зовёт: имя агента для журнала правок. */
interface CallContext {
  actor: string
}

type Handlers = {
  [M in AgentMethod]: (
    params: AgentMethods[M]['params'],
    ctx: CallContext
  ) => Promise<AgentMethods[M]['result']>
}

interface Options {
  store: DocStore
  camera: CameraController
  settings: Settings
  handlers: RefObject<CommandHandlers>
  web: WebRuntime
  desktops: DesktopsApi
  save(): Promise<void>
}

/**
 * Холст отвечает агентам из MCP. Каждая правка идёт через `store.mutate` — в ту же
 * историю, что и руками: человек отменит её обычным Ctrl+Z.
 */
export function useAgentBridge(options: Options): void {
  const ref = useRef(options)
  useEffect(() => {
    ref.current = options
  })

  useEffect(() => {
    const viewport = (): AgentMethods['zoomTo']['result']['viewport'] => {
      const { camera } = ref.current
      return { ...camera.visibleRect(), zoom: camera.value.zoom }
    }

    /** Всё, что для новой ноды надо узнать асинхронно: размер картинки, шелл терминала. */
    interface Prep {
      size: { width: number; height: number }
      shell: string
    }
    const prepareCreate = async (init: AgentNodeInit, place: AgentPlacement): Promise<Prep> => {
      const { settings } = ref.current
      const terminal = init.kind === 'terminal' || init.kind === 'agent'
      const fallback = terminal ? await window.api.terminal.defaultShell() : ''
      const shellPath = settings.terminal.shell || fallback
      let size = defaultSize(init, {
        text: settings.nodes.defaultTextSize,
        web: settings.nodes.defaultWebSize
      })
      if (init.kind === 'file' && isImageFile(init.file) && place.width === undefined) {
        const natural = await window.api.files.imageSize(init.file)
        if (natural) {
          const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(natural.width, natural.height))
          size = { width: Math.round(natural.width * scale), height: Math.round(natural.height * scale) }
        }
      }
      return { size, shell: shellPath.split(/[\\/]/).pop() ?? shellPath }
    }

    /** Нода на своём месте в данном документе — синхронно, чтобы пакет шёл одной правкой. */
    const buildPlaced = (
      doc: CanvasDoc,
      init: AgentNodeInit,
      place: AgentPlacement,
      color: CanvasColor | undefined,
      prep: Prep
    ): DocNode => {
      const { camera, settings, desktops } = ref.current
      if (place.desktop !== undefined && !isDesktop(place.desktop)) {
        throw new AgentOpError(`стол ${place.desktop}: нужен 1…10`)
      }
      const rect = placeRect(doc, place, prep.size, camera.visibleRect(), (d) =>
        d === desktops.currentRef.current
          ? camera.visibleRect()
          : visibleWorldRect(desktops.cameraFor(d), camera.viewportSize)
      )
      return buildNode(doc, init, rect, {
        shell: prep.shell,
        ...(color ? { color } : {}),
        defaultAgent: settings.agents.default
      })
    }

    /** Кто сейчас зовёт холст — для обработчиков, которым это важно (огонёк от агента). */
    let currentCaller: string | null = null

    const handlers: Handlers = {
      getCanvas: async ({ maxText }) => {
        const { store } = ref.current
        const state = store.snapshot
        return {
          nodes: state.doc.nodes.map((n) => toAgentNode(n, maxText)),
          edges: state.doc.edges.map(toAgentEdge),
          selection: [...state.selection],
          edgeSelection: [...state.edgeSelection],
          activeNodeId: state.activeNodeId,
          viewport: viewport(),
          activeDesktop: ref.current.desktops.currentRef.current,
          dirty: state.dirty,
          canUndo: state.canUndo,
          canRedo: state.canRedo
        }
      },
      getNodes: async ({ ids }) => {
        const { doc } = ref.current.store
        return ids.map((id) => {
          const node = doc.nodes.find((n) => n.id === id)
          if (!node) throw new AgentOpError(`нет ноды ${id}`)
          return toAgentNode(node)
        })
      },
      findTerminal: async ({ ref: wanted }) => {
        const { node, match } = lookupTerminal(ref.current.store.doc, wanted)
        if (!node) {
          throw new AgentOpError(
            `${notFoundMessage('терминала или агента', wanted, match, describeNamed)} — см. list_terminals`
          )
        }
        return toAgentNode(node)
      },
      findWeb: async ({ ref: wanted }) => {
        const { node, match } = lookupWeb(ref.current.store.doc, wanted)
        if (!node) {
          throw new AgentOpError(
            `${notFoundMessage('веб-страницы', wanted, match, describeNamed)} — см. get_canvas kinds=[web]`
          )
        }
        return { node: toAgentNode(node), webContentsId: ref.current.web.guestIdFor(node.id) }
      },
      createNode: async ({ init, place, color }, { actor }) => {
        const prep = await prepareCreate(init, place)
        const { store } = ref.current
        const node = buildPlaced(store.doc, init, place, color, prep)
        store.mutate(`агент: ${init.kind}`, (doc) => insertNodes(doc, [node]), actor)
        return toAgentNode(node)
      },
      updateNode: async ({ id, patch, restart }) => {
        const { store } = ref.current
        store.mutate('агент: правка', (doc) => applyNodePatch(doc, id, patch))
        // Новая сессия агента: процесс перезапускается и продолжает её.
        if (restart && patch.sessionId !== undefined) requestTerminalRestart(id)
        const node = store.doc.nodes.find((n) => n.id === id)
        if (!node) throw new AgentOpError(`нет ноды ${id}`)
        return toAgentNode(node)
      },
      createEdge: async (init) => {
        const { store } = ref.current
        const edge = buildEdge(store.doc, init)
        store.mutate('агент: связь', (doc) => insertEdges(doc, [edge]))
        return toAgentEdge(edge)
      },
      updateEdge: async ({ id, patch }) => {
        const { store } = ref.current
        store.mutate('агент: связь', (doc) => applyEdgePatch(doc, id, patch))
        const edge = store.doc.edges.find((e) => e.id === id)
        if (!edge) throw new AgentOpError(`нет связи ${id}`)
        return toAgentEdge(edge)
      },
      delete: async ({ ids }) => {
        const { store } = ref.current
        const split = splitIds(store.doc, ids)
        store.mutate('агент: удаление', (doc) =>
          deleteEntities(doc, new Set(split.nodes), new Set(split.edges))
        )
        return split
      },
      select: async ({ ids }) => {
        const { store } = ref.current
        const split = splitIds(store.doc, ids)
        if (ids.length === 0) store.clearSelection()
        else {
          store.selectNodes(split.nodes, 'replace')
          if (split.edges.length > 0)
            store.selectEdges(split.edges, split.nodes.length > 0 ? 'add' : 'replace')
        }
        return split
      },
      zoomTo: async ({ ids }) => {
        const { store, camera } = ref.current
        if (ids.length === 0) {
          const bounds = docBounds(store.doc)
          if (bounds) camera.fit(bounds)
        } else {
          const rects = ids.map((id) => {
            const node = store.doc.nodes.find((n) => n.id === id)
            if (!node) throw new AgentOpError(`нет ноды ${id}`)
            return nodeRect(node)
          })
          camera.fitAll(rects)
        }
        return { viewport: viewport() }
      },
      runCommand: async ({ id }) => {
        const handler = ref.current.handlers.current?.[id]
        if (!handler) throw new AgentOpError(`команда ${id} сейчас недоступна`)
        handler()
        return { ran: true }
      },
      batch: async ({ ops }, { actor }) => {
        // Всё асинхронное (размер картинки, шелл) — до правки: сама правка одна и синхронная,
        // упала любая операция — документ не тронут.
        const preps = await Promise.all(
          ops.map((op) => (op.op === 'create_node' ? prepareCreate(op.init, op.place) : null))
        )
        const { store } = ref.current
        const refs: Record<string, string> = {}
        const created: { index: number; id: string; kind: 'node' | 'edge' }[] = []
        const deleted = new Map<number, { nodes: string[]; edges: string[] }>()
        const real = (id: string): string => {
          if (!id.startsWith('$')) return id
          const found = refs[id.slice(1)]
          if (!found) throw new AgentOpError(`ссылка ${id} не объявлена раньше в пакете`)
          return found
        }
        store.mutate(
          `агент: пакет из ${ops.length}`,
          (doc) => {
            let next = doc
            ops.forEach((op, index) => {
              try {
                switch (op.op) {
                  case 'create_node': {
                    const place = { ...op.place, ...(op.place.near ? { near: real(op.place.near) } : {}) }
                    const node = buildPlaced(next, op.init, place, op.color, preps[index]!)
                    next = insertNodes(next, [node])
                    if (op.ref) refs[op.ref] = node.id
                    created.push({ index, id: node.id, kind: 'node' })
                    break
                  }
                  case 'update_node':
                    next = applyNodePatch(next, real(op.id), op.patch)
                    break
                  case 'create_edge': {
                    const edge = buildEdge(next, {
                      ...op.edge,
                      fromNode: real(op.edge.fromNode),
                      toNode: real(op.edge.toNode)
                    })
                    next = insertEdges(next, [edge])
                    if (op.ref) refs[op.ref] = edge.id
                    created.push({ index, id: edge.id, kind: 'edge' })
                    break
                  }
                  case 'update_edge':
                    next = applyEdgePatch(next, real(op.id), op.patch)
                    break
                  case 'delete': {
                    const split = splitIds(next, op.ids.map(real))
                    next = deleteEntities(next, new Set(split.nodes), new Set(split.edges))
                    deleted.set(index, split)
                    break
                  }
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                throw new AgentOpError(`операция ${index + 1} (${op.op}): ${message} — пакет не применён`)
              }
            })
            return next
          },
          actor
        )
        const doc = store.doc
        const results = ops.map((op, index) => {
          const removed = deleted.get(index)
          if (removed) return removed
          const id =
            created.find((c) => c.index === index)?.id ??
            (op.op === 'update_node' || op.op === 'update_edge' ? real(op.id) : '')
          const node = doc.nodes.find((n) => n.id === id)
          if (node) return toAgentNode(node)
          const edge = doc.edges.find((e) => e.id === id)
          if (edge) return toAgentEdge(edge)
          throw new AgentOpError(`операция ${index + 1}: результат пропал`)
        })
        return { results, refs }
      },
      history: async ({ since, limit }) => {
        const all = ref.current.store.journal.filter((e) => since === undefined || e.at > since)
        return all.slice(-(limit ?? all.length)).map((e) => ({ ...e }))
      },
      snapshotSource: async ({ ids, rect, padding }) => {
        const { store, web } = ref.current
        const doc = store.doc
        let nodes: DocNode[]
        if (ids?.length) {
          const wanted = new Set(ids)
          const missing = ids.filter((id) => !doc.nodes.some((n) => n.id === id))
          if (missing.length > 0) throw new AgentOpError(`нет нод ${missing.join(', ')}`)
          // Группа тянет за собой то, что в ней лежит, — как на экране.
          for (const g of doc.nodes) {
            if (g.type === 'group' && wanted.has(g.id))
              for (const id of nodesInsideGroup(doc, g.id)) wanted.add(id)
          }
          nodes = doc.nodes.filter((n) => wanted.has(n.id))
        } else if (rect) {
          nodes = doc.nodes.filter((n) => rectsIntersect(nodeRect(n), rect))
        } else {
          throw new AgentOpError('нужны ids или rect')
        }
        const bounds = rect ?? unionRects(nodes.map(nodeRect))
        if (!bounds) throw new AgentOpError('снимать нечего')
        const pad = rect ? 0 : (padding ?? 24)
        const area = {
          x: bounds.x - pad,
          y: bounds.y - pad,
          width: bounds.width + pad * 2,
          height: bounds.height + pad * 2
        }
        const kept = new Set(nodes.map((n) => n.id))
        const terminals: Record<string, string> = {}
        const webGuests: Record<string, number> = {}
        for (const n of nodes) {
          if (isTerminal(n)) terminals[n.id] = readTerminalScreen(n.id, 200)?.text ?? ''
          if (n.type === 'link') {
            const guest = web.guestIdFor(n.id)
            if (guest !== null) webGuests[n.id] = guest
          }
        }
        return {
          nodes,
          edges: doc.edges.filter((e) => kept.has(e.fromNode) && kept.has(e.toNode)),
          rect: area,
          terminals,
          webGuests
        }
      },
      noteFetch: async ({ url }) => {
        const from = currentCaller
        if (!from) return { pulsed: [] }
        let host: string
        try {
          host = new URL(url).host
        } catch {
          return { pulsed: [] }
        }
        const doc = ref.current.store.doc
        const pages = doc.nodes.filter((n) => {
          if (n.type !== 'link') return false
          try {
            return new URL(n.url).host === host
          } catch {
            return false
          }
        })
        for (const page of pages) {
          // Есть стрелка — по ней; нет — по воздуху, без новой стрелки на холсте.
          if (!pulseBetween(doc, from, page.id)) pulseGhost(from, page.id)
        }
        return { pulsed: pages.map((p) => p.id) }
      },
      restore: async ({ ids }) => {
        const { store } = ref.current
        const restored: string[] = []
        const missing: string[] = []
        const alreadyThere: string[] = []
        const nodes: DocNode[] = []
        const edges = new Map<string, DocEdge>()
        for (const id of ids) {
          if (store.doc.nodes.some((n) => n.id === id)) {
            alreadyThere.push(id)
            continue
          }
          const grave = store.tombstone(id)
          if (!grave) {
            missing.push(id)
            continue
          }
          nodes.push(grave.node)
          restored.push(id)
          for (const e of grave.edges) edges.set(e.id, e)
        }
        if (nodes.length === 0) return { restored, edges: [], missing, alreadyThere }
        const alive = new Set([...store.doc.nodes.map((n) => n.id), ...restored])
        const existingEdges = new Set(store.doc.edges.map((e) => e.id))
        const back = [...edges.values()].filter(
          (e) => !existingEdges.has(e.id) && alive.has(e.fromNode) && alive.has(e.toNode)
        )
        store.mutate('агент: восстановление', (doc) => insertEdges(insertNodes(doc, nodes), back))
        return { restored, edges: back.map((e) => e.id), missing, alreadyThere }
      },
      save: async () => {
        await ref.current.save()
        return { saved: true }
      },
      switchDesktop: async ({ desktop }) => {
        if (!isDesktop(desktop)) throw new AgentOpError(`стол ${desktop}: нужен 1…10`)
        ref.current.desktops.switchTo(desktop)
        return { activeDesktop: desktop }
      },
      moveToDesktop: async ({ ids, desktop }) => {
        if (!isDesktop(desktop)) throw new AgentOpError(`стол ${desktop}: нужен 1…10`)
        const { store } = ref.current
        const { nodes } = splitIds(store.doc, ids)
        store.mutate(`агент: на стол ${desktop}`, (doc) => moveToDesktop(doc, nodes, desktop))
        return { moved: nodes }
      },
      readTerminal: async ({ id, lines }) => {
        const screen = readTerminalScreen(id, lines)
        if (!screen) throw new AgentOpError(`терминал ${id} не открыт на холсте`)
        return screen
      }
    }

    /** Агент для журнала: «Бесстрашная Прасковья (агент abc…)», снаружи — «внешний клиент MCP». */
    const actorOf = (request: AgentRequest): string => {
      if (!request.caller) return 'MCP'
      const id = request.caller.nodeId
      if (!id) return 'внешний клиент MCP'
      const node = ref.current.store.doc.nodes.find((n) => n.id === id)
      return `${(node && nodeName(node)) ?? 'агент'} (${id})`
    }

    const run = async (request: AgentRequest): Promise<unknown> => {
      const handler = handlers[request.method] as (params: unknown, ctx: CallContext) => Promise<unknown>
      if (!handler) throw new AgentOpError(`нет метода ${request.method}`)
      const actor = actorOf(request)
      currentCaller = request.caller?.nodeId ?? null
      // Синхронная часть обработчика (а это почти все правки) идёт от имени агента; кто правит
      // после await (createNode, batch), передаёт actor сам.
      const result = await ref.current.store.asActor(actor, () => handler(request.params, { actor }))
      const from = request.caller?.nodeId
      if (from) for (const to of touchedNodes(request, result)) pulseBetween(ref.current.store.doc, from, to)
      return result
    }

    const off = window.api.agent.onRequest((request) => {
      run(request).then(
        (result) => window.api.agent.respond({ id: request.id, ok: true, result }),
        (error: unknown) =>
          window.api.agent.respond({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
      )
    })
    window.api.agent.ready()
    return off
  }, [])
}

/**
 * К каким нодам обратился агент этим запросом: написал агенту или прочитал его терминал
 * (findTerminal / readTerminal), прочитал или поправил страницу (findWeb), карточку
 * (getNodes, updateNode). По ним и бежит импульс.
 */
function touchedNodes(request: AgentRequest, result: unknown): string[] {
  const params = request.params as Record<string, unknown>
  switch (request.method) {
    case 'findTerminal':
      return [(result as { id: string }).id]
    case 'findWeb':
      return [(result as { node: { id: string } }).node.id]
    case 'readTerminal':
    case 'updateNode':
      return [params.id as string]
    case 'getNodes':
      return params.ids as string[]
    default:
      return []
  }
}

/** Импульс по связи между нодами, в какую бы сторону ни смотрела стрелка. Была ли связь. */
function pulseBetween(doc: CanvasDoc, from: string, to: string): boolean {
  if (from === to) return false
  let found = false
  for (const e of doc.edges) {
    if (e.fromNode === from && e.toNode === to) pulseEdge(e.id, false)
    else if (e.fromNode === to && e.toNode === from) pulseEdge(e.id, true)
    else continue
    found = true
  }
  return found
}
