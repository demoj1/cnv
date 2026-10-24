import { useEffect, useRef, type RefObject } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { docBounds, nodeRect } from '@core/document'
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
import { deleteEntities, insertEdges, insertNodes } from '@core/ops'
import { describeNamed, lookupTerminal, lookupWeb } from '@core/terminal-identity'
import { notFoundMessage } from '@core/name-match'
import type { AgentMethod, AgentMethods, AgentNodeInit, AgentPlacement, AgentRequest } from '@shared/agent'
import type { CanvasColor } from '@shared/canvas'
import type { CanvasDoc, DocNode } from '@core/document'
import type { Settings } from '@shared/settings'
import type { CommandHandlers } from '../commands/useCommands'
import { readTerminalScreen } from '../nodes/terminal-registry'
import type { WebRuntime } from '../web/context'
import type { DesktopsApi } from './useDesktops'
import { visibleWorldRect } from '@core/camera'
import { isDesktop, moveToDesktop } from '@core/desktops'

/** Картинку агента без размеров вписываем в такой квадрат, сохраняя пропорции. */
const IMAGE_MAX_SIDE = 600

type Handlers = {
  [M in AgentMethod]: (params: AgentMethods[M]['params']) => Promise<AgentMethods[M]['result']>
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
      createNode: async ({ init, place, color }) => {
        const prep = await prepareCreate(init, place)
        const { store } = ref.current
        const node = buildPlaced(store.doc, init, place, color, prep)
        store.mutate(`агент: ${init.kind}`, (doc) => insertNodes(doc, [node]))
        return toAgentNode(node)
      },
      updateNode: async ({ id, patch }) => {
        const { store } = ref.current
        store.mutate('агент: правка', (doc) => applyNodePatch(doc, id, patch))
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
      batch: async ({ ops }) => {
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
        store.mutate(`агент: пакет из ${ops.length}`, (doc) => {
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
        })
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

    const run = async (request: AgentRequest): Promise<unknown> => {
      const handler = handlers[request.method] as (params: unknown) => Promise<unknown>
      if (!handler) throw new AgentOpError(`нет метода ${request.method}`)
      return handler(request.params)
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
