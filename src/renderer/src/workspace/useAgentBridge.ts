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
import { findTerminal, findWeb } from '@core/terminal-identity'
import type { AgentMethod, AgentMethods, AgentRequest } from '@shared/agent'
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
        const node = findTerminal(ref.current.store.doc, wanted)
        if (!node) throw new AgentOpError(`нет терминала или агента «${wanted}» — см. list_terminals`)
        return toAgentNode(node)
      },
      findWeb: async ({ ref: wanted }) => {
        const node = findWeb(ref.current.store.doc, wanted)
        if (!node) throw new AgentOpError(`нет веб-страницы «${wanted}» — см. get_canvas kinds=[web]`)
        return { node: toAgentNode(node), webContentsId: ref.current.web.guestIdFor(node.id) }
      },
      createNode: async ({ init, place, color }) => {
        const { store, camera, settings } = ref.current
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
        const { desktops } = ref.current
        if (place.desktop !== undefined && !isDesktop(place.desktop)) {
          throw new AgentOpError(`стол ${place.desktop}: нужен 1…10`)
        }
        const rect = placeRect(store.doc, place, size, camera.visibleRect(), (d) =>
          d === desktops.currentRef.current
            ? camera.visibleRect()
            : visibleWorldRect(desktops.cameraFor(d), camera.viewportSize)
        )
        const node = buildNode(store.doc, init, rect, {
          shell: shellPath.split(/[\\/]/).pop() ?? shellPath,
          ...(color ? { color } : {}),
          newSessionId: () => crypto.randomUUID()
        })
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
