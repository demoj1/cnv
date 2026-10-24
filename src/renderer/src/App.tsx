import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CameraController } from '@core/camera-controller'
import { DocStore } from '@core/doc-store'
import { findNode, nodeRect, replaceNodes, type CanvasDoc, type DocNode } from '@core/document'
import { nodeKind } from '@core/node-kind'
import { visualBounds } from '@core/image-edit'
import { isTerminal } from '@core/terminal'
import type { Point, Rect, Size } from '@core/geometry'
import type { CanvasColor } from '@shared/canvas'
import type { Guide } from '@core/snapping'
import {
  alignRects,
  distributeRects,
  equalizeRects,
  packRects,
  type AlignEdge,
  type DistributeAxis,
  type EqualizeMode,
  type PackMode
} from '@core/align'
import {
  deleteEntities,
  duplicateSubgraph,
  groupSelection,
  insertEdges,
  insertNodes,
  makeEdge,
  makeNode,
  moveNodes,
  patchEdge,
  patchNodes,
  reorderNodes,
  ungroup,
  type NodeInit
} from '@core/ops'
import { DEFAULT_SETTINGS, UI_SCALES, type Settings } from '@shared/settings'
import { CanvasView } from './canvas/CanvasView'
import { CanvasEnvContext } from './canvas/env'
import { NodesLayer } from './canvas/NodesLayer'
import { InteractionOverlay } from './canvas/InteractionOverlay'
import { CropEditor } from './canvas/CropEditor'
import { ImageColorPanel } from './canvas/ImageColorPanel'
import { TextFontPanel } from './canvas/TextFontPanel'
import { EyedropperOverlay } from './canvas/EyedropperOverlay'
import { EdgesLayer } from './canvas/EdgesLayer'
import { EdgeLabelEditor } from './ui/EdgeLabelEditor'
import { useCanvasInteractions, type EdgeDraft, type MarqueeState } from './canvas/useCanvasInteractions'
import { useCameraValue, useVisibleRect } from './canvas/useCameraValue'
import { useDocState } from './canvas/useDocState'
import { useCommands, type CommandHandlers } from './commands/useCommands'
import { registerBuiltinNodeTypes } from './nodes'
import { Hud } from './ui/Hud'
import { ConflictDialog } from './ui/ConflictDialog'
import { useTheme } from './ui/useTheme'
import { useAutoEdgeSides } from './canvas/useAutoEdgeSides'
import { useCanvasFile } from './workspace/useCanvasFile'
import { useAgentBridge } from './workspace/useAgentBridge'
import { useTerminalIdentity } from './workspace/useTerminalIdentity'
import { useDesktops } from './workspace/useDesktops'
import { DesktopBar } from './ui/DesktopBar'
import { CreateBar, type CreateKind } from './ui/CreateBar'
import { DESKTOP_COUNT, nodesOnDesktop } from '@core/desktops'
import { nodeNames } from '@core/agent-ops'
import { uniqueName } from '@core/names'
import { isNameable, nodeName, nodeRole, withNodeName, withNodeRole } from '@core/node-name'
import { useClipboardAndDrop } from './workspace/useClipboardAndDrop'
import { WebLiveContext, WebRuntimeContext } from './web/context'
import { useWebLifecycle } from './web/useWebLifecycle'
import { UrlPrompt } from './ui/UrlPrompt'
import { TextPrompt } from './ui/TextPrompt'
import { SettingsPanel } from './ui/SettingsPanel'
import { ShortcutsHelp } from './ui/ShortcutsHelp'
import { ContextMenu, type ContextMenuState } from './ui/ContextMenu'

registerBuiltinNodeTypes()

function shiftUiScale(current: number, step: number): void {
  const index = UI_SCALES.indexOf(current as (typeof UI_SCALES)[number])
  const from = index >= 0 ? index : 0
  const next = UI_SCALES[Math.min(UI_SCALES.length - 1, Math.max(0, from + step))]
  if (next !== undefined && next !== current) void window.api.settings.patch({ uiScale: next })
}

const NUDGE = 1
const TERMINAL_SIZE: Size = { width: 720, height: 420 }
const FILE_SIZE: Size = { width: 400, height: 300 }

/** Куда ставить новую ноду: её центр в мире и ноды, от которых к ней провести стрелки. */
interface Placement {
  at: Point
  from: readonly string[]
}

export function App(): React.JSX.Element {
  const camera = useMemo(() => new CameraController(), [])
  const store = useMemo(() => new DocStore(), [])
  const nodeRefs = useMemo(() => new Map<string, HTMLElement>(), [])
  const viewportRef = useRef<HTMLDivElement>(null)

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [guides, setGuides] = useState<readonly Guide[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EdgeDraft | null>(null)
  const [editingEdge, setEditingEdge] = useState<string | null>(null)

  const file = useCanvasFile(store, camera)
  const desktops = useDesktops(store, camera, file.desktopCameras)
  useAutoEdgeSides(store, settings.edges.autoSides)
  useTerminalIdentity(store)
  const clipboard = useClipboardAndDrop(store, camera, settings, viewportRef)
  const { runtime: webRuntime, liveIds } = useWebLifecycle(store, camera, settings)
  // Куда поставить страницу после ввода адреса: центр ноды и с кем её связать.
  const [urlPrompt, setUrlPrompt] = useState<Placement | null>(null)
  const [namePrompt, setNamePrompt] = useState<{ nodeId: string; field: 'name' | 'role' } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null)
  const [cropping, setCropping] = useState<string | null>(null)
  const [eyedropper, setEyedropper] = useState(false)

  const docState = useDocState(store)
  const cam = useCameraValue(camera)
  // Терминал за экраном нельзя размонтировать: cleanup убьёт его процесс. У каждого
  // терминала процесс живой всё время, пока нода есть, — держим их смонтированными
  // так же, как живые веб-страницы.
  const keepMounted = useMemo(() => {
    const ids = new Set(liveIds)
    for (const n of docState.doc.nodes) if (isTerminal(n)) ids.add(n.id)
    return ids
  }, [liveIds, docState.doc.nodes])
  const visible = useVisibleRect(camera, window.innerHeight / 2)

  useTheme(settings.theme)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    const offSettings = window.api.settings.onChanged(setSettings)
    return () => {
      offSettings()
    }
  }, [])

  useEffect(() => window.api.canvas.onOpenRequest((relPath) => void file.open(relPath)), [file])

  const screenCenter = useCallback((): Point => {
    const v = camera.visibleRect()
    return { x: v.x + v.width / 2, y: v.y + v.height / 2 }
  }, [camera])

  /**
   * Новая нода с центром в `center`, выделенная. `from` — ноды, от которых к ней тянутся
   * стрелки: так вытащенный из панели агент сразу попадает в команду выделенного.
   */
  const spawnNode = useCallback(
    (
      label: string,
      init: (doc: CanvasDoc) => NodeInit,
      size: Size,
      center: Point,
      from: readonly string[] = []
    ) => {
      let id = ''
      store.mutate(label, (doc) => {
        const node = makeNode(init(doc), {
          x: Math.round(center.x - size.width / 2),
          y: Math.round(center.y - size.height / 2),
          ...size
        })
        id = node.id
        // Из группы стрелка ни о чём не говорит — связываем только с самими нодами.
        const linked = from.filter((f) => {
          const source = findNode(doc, f)
          return source !== undefined && source.type !== 'group'
        })
        const edges = linked.map((f) => makeEdge(f, id))
        return insertEdges(insertNodes(doc, [node]), edges)
      })
      if (id) store.selectNodes([id])
      return id
    },
    [store]
  )

  const createWebNode = useCallback(
    (url: string, place: Placement | null, near?: DocNode) => {
      const size = settings.nodes.defaultWebSize
      const center = near
        ? { x: near.x + near.width + 40 + size.width / 2, y: near.y + size.height / 2 }
        : (place?.at ?? screenCenter())
      spawnNode('веб-нода', () => ({ type: 'link', url }), size, center, place?.from)
    },
    [settings, screenCenter, spawnNode]
  )

  useEffect(
    () =>
      window.api.web.onGuestWindowOpen(({ url }) => {
        const active = store.snapshot.activeNodeId
        const near = active ? store.doc.nodes.find((n) => n.id === active) : undefined
        createWebNode(url, null, near)
      }),
    [store, createWebNode]
  )

  useEffect(() => () => camera.dispose(), [camera])

  const createTextAt = useCallback(
    (world: Point, from: readonly string[] = []) => {
      const id = spawnNode(
        'новая карточка',
        () => ({ type: 'text', text: '' }),
        settings.nodes.defaultTextSize,
        world,
        from
      )
      if (id) store.setActiveNode(id)
    },
    [store, settings, spawnNode]
  )

  useCanvasInteractions(viewportRef, {
    store,
    camera,
    settings,
    nodeRefs,
    onMarquee: setMarquee,
    onGuides: setGuides,
    onHover: setHoveredId,
    onEdgeDraft: setDraft,
    onCreateTextAt: createTextAt,
    onCropImage: setCropping
  })

  const croppingNode = cropping ? (docState.doc.nodes.find((n) => n.id === cropping) ?? null) : null

  // Единственная выделенная картинка — для её панели маски по цвету и пипетки.
  const selectedImage = (() => {
    if (docState.selection.size !== 1 || docState.activeNodeId || cropping) return null
    const id = [...docState.selection][0]
    const n = id ? docState.doc.nodes.find((x) => x.id === id) : undefined
    return n && nodeKind(n) === 'image' ? n : null
  })()

  // Единственная выделенная карточка — для её панели шрифта.
  const selectedText = (() => {
    if (docState.selection.size !== 1 || docState.activeNodeId || cropping) return null
    const id = [...docState.selection][0]
    const n = id ? docState.doc.nodes.find((x) => x.id === id) : undefined
    return n && nodeKind(n) === 'text' ? n : null
  })()

  const applyLayout = useCallback(
    (label: string, compute: (items: { id: string; rect: Rect }[]) => Map<string, Rect>) => {
      const items = store.doc.nodes
        .filter((n) => store.snapshot.selection.has(n.id))
        .map((n) => ({ id: n.id, rect: visualBounds(n) }))
      const changed = compute(items)
      if (changed.size === 0) return
      const patches = new Map<string, Partial<DocNode>>()
      for (const [id, rect] of changed) {
        patches.set(id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }
      store.mutate(label, (doc) => patchNodes(doc, patches))
    },
    [store]
  )

  const alignHandlers = useMemo(() => {
    const edges: Record<string, AlignEdge> = {
      'align.left': 'left',
      'align.centerX': 'centerX',
      'align.right': 'right',
      'align.top': 'top',
      'align.centerY': 'centerY',
      'align.bottom': 'bottom'
    }
    const distribute: Record<string, DistributeAxis> = {
      'align.distributeX': 'x',
      'align.distributeY': 'y'
    }
    const equalize: Record<string, EqualizeMode> = {
      'align.sameWidth': 'width',
      'align.sameHeight': 'height',
      'align.sameSize': 'both'
    }
    const pack: Record<string, PackMode> = { 'align.packRow': 'row', 'align.packGrid': 'grid' }

    const out: Record<string, () => void> = {}
    for (const [id, edge] of Object.entries(edges)) {
      out[id] = () => applyLayout('выравнивание', (items) => alignRects(items, edge))
    }
    for (const [id, axis] of Object.entries(distribute)) {
      out[id] = () => applyLayout('распределение', (items) => distributeRects(items, axis))
    }
    for (const [id, mode] of Object.entries(equalize)) {
      out[id] = () => applyLayout('уравнять размер', (items) => equalizeRects(items, mode))
    }
    for (const [id, mode] of Object.entries(pack)) {
      out[id] = () => applyLayout('упаковка', (items) => packRects(items, mode, 24))
    }
    return out
  }, [applyLayout])

  const colorHandlers = useMemo(() => {
    const out: Record<string, () => void> = {}
    for (const value of ['none', '1', '2', '3', '4', '5', '6']) {
      out[`color.${value}`] = () => {
        const color = value === 'none' ? undefined : (value as CanvasColor)
        store.mutate('цвет', (doc) => {
          const nodes = new Map<string, Partial<DocNode>>()
          for (const n of doc.nodes) if (store.snapshot.selection.has(n.id)) nodes.set(n.id, { color })
          let next = patchNodes(doc, nodes)
          for (const e of doc.edges) {
            if (store.snapshot.edgeSelection.has(e.id)) next = patchEdge(next, e.id, { color })
          }
          return next
        })
      }
    }
    return out
  }, [store])

  const selectedRects = useMemo(
    () => docState.doc.nodes.filter((n) => docState.selection.has(n.id)).map(nodeRect),
    [docState.doc, docState.selection]
  )

  /** Единственная выделенная нода, у которой бывают имя и роль. */
  function singleNameable(): DocNode | null {
    const state = store.snapshot
    if (state.selection.size !== 1) return null
    const id = [...state.selection][0]
    const node = state.doc.nodes.find((n) => n.id === id)
    return node && isNameable(node) ? node : null
  }

  /** Терминал или агент; агенту — новая сессия Claude Code. */
  function createTerminal(agent: boolean, place: Placement | null = null): void {
    void window.api.terminal.defaultShell().then((fallback) => {
      const shell = settings.terminal.shell || fallback
      spawnNode(
        agent ? 'агент' : 'терминал',
        (doc) => ({
          type: 'terminal',
          shell: shell.split('/').pop() ?? shell,
          name: uniqueName(nodeNames(doc)),
          ...(agent ? { agent: { sessionId: crypto.randomUUID() } } : {})
        }),
        TERMINAL_SIZE,
        place?.at ?? screenCenter(),
        place?.from
      )
    })
  }

  /** Файлы с диска: каждый следующий чуть ниже и правее предыдущего. */
  function createFiles(place: Placement | null): void {
    void window.api.files.choose().then(async (paths) => {
      const center = place?.at ?? screenCenter()
      for (const [i, source] of paths.entries()) {
        const imported = await window.api.attachments.importPath(source)
        const at = { x: center.x + i * 24, y: center.y + i * 24 }
        spawnNode('файл', () => ({ type: 'file', file: imported.relPath }), FILE_SIZE, at, place?.from)
      }
    })
  }

  const sizeOf = (kind: CreateKind): Size => {
    switch (kind) {
      case 'text':
        return settings.nodes.defaultTextSize
      case 'web':
        return settings.nodes.defaultWebSize
      case 'file':
        return FILE_SIZE
      case 'terminal':
      case 'agent':
        return TERMINAL_SIZE
    }
  }

  /** Из панели слева: в точку, куда дотащили (или в центр экрана), со стрелками от выделенных. */
  function createFromBar(kind: CreateKind, at: Point | null): void {
    const place: Placement = {
      at: at ?? screenCenter(),
      from: [...store.snapshot.selection]
    }
    switch (kind) {
      case 'text':
        createTextAt(place.at, place.from)
        return
      case 'web':
        setUrlPrompt(place)
        return
      case 'file':
        createFiles(place)
        return
      case 'terminal':
      case 'agent':
        createTerminal(kind === 'agent', place)
    }
  }

  const desktopHandlers: CommandHandlers = {}
  for (let n = 1; n <= DESKTOP_COUNT; n++) {
    desktopHandlers[`desktop.${n}`] = () => desktops.switchTo(n)
    desktopHandlers[`desktop.move${n}`] = () => desktops.moveSelectionTo(n)
  }

  const handlers: CommandHandlers = {
    'canvas.chooseFile': () => void window.api.canvas.chooseFile(),
    'canvas.save': () => void file.save(),
    'edit.undo': () => store.undo(),
    'edit.redo': () => store.redo(),
    'edit.redoAlt': () => store.redo(),
    'edit.delete': () =>
      store.mutate('удаление', (doc) => deleteEntities(doc, docState.selection, docState.edgeSelection)),
    'edit.copy': () => void clipboard.copy(),
    'edit.cut': () => void clipboard.cut(),
    'edit.paste': () => void clipboard.paste(),
    'edit.duplicate': () => {
      store.mutate('дублирование', (doc) => duplicateSubgraph(doc, docState.selection, { x: 24, y: 24 }).doc)
    },
    'edit.resetSize': () => {
      void (async () => {
        const targets = store.doc.nodes.filter((n) => store.snapshot.selection.has(n.id) && n.type === 'file')
        const patches = new Map<string, Partial<DocNode>>()
        for (const n of targets) {
          if (n.type !== 'file') continue
          const size = await window.api.files.imageSize(n.file)
          if (size) patches.set(n.id, { width: size.width, height: size.height })
        }
        if (patches.size > 0) store.mutate('исходный размер', (doc) => patchNodes(doc, patches))
      })()
    },
    ...colorHandlers,
    'selection.all': () => store.selectAll(),
    'selection.none': () => {
      if (store.snapshot.activeNodeId) store.setActiveNode(null)
      else store.clearSelection()
    },
    'create.web': () => setUrlPrompt({ at: screenCenter(), from: [] }),
    'create.group': () => {
      store.mutate('группировка', (doc) => {
        const result = groupSelection(doc, docState.selection, 24, 'Группа', settings.nodes.minSize)
        return result ? result.doc : doc
      })
    },
    'create.ungroup': () => store.mutate('разгруппировка', (doc) => ungroup(doc, docState.selection)),
    ...alignHandlers,
    'create.text': () => createTextAt(screenCenter()),
    'create.terminal': () => createTerminal(false),
    'create.agent': () => createTerminal(true),
    'node.rename': () => {
      const node = singleNameable()
      if (node) setNamePrompt({ nodeId: node.id, field: 'name' })
    },
    'node.role': () => {
      const node = singleNameable()
      if (node) setNamePrompt({ nodeId: node.id, field: 'role' })
    },
    'arrange.front': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'front')),
    'arrange.back': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'back')),
    'arrange.forward': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'forward')),
    'arrange.backward': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'backward')),
    'view.zoomReset': () => camera.zoomToCenter(1),
    'view.zoomIn': () => camera.zoomToCenter(camera.value.zoom * 1.25),
    'view.zoomOut': () => camera.zoomToCenter(camera.value.zoom / 1.25),
    'view.zoomFit': () => {
      // «Всё» — это всё на текущем столе: соседние столы далеко, вписывать их бессмысленно.
      camera.fitAll(nodesOnDesktop(docState.doc, desktops.currentRef.current).map(nodeRect))
    },
    ...desktopHandlers,
    'view.zoomSelection': () => camera.fitAll(selectedRects),
    'view.settings': () => setSettingsOpen(true),
    'view.uiScaleUp': () => shiftUiScale(settings.uiScale, 1),
    'view.uiScaleDown': () => shiftUiScale(settings.uiScale, -1),
    'help.shortcuts': () => setHelpOpen(true),
    'create.file': () => createFiles(null),
    'view.toggleGrid': () => void window.api.settings.patch({ grid: { show: !settings.grid.show } }),
    'view.toggleSnap': () => void window.api.settings.patch({ grid: { snap: !settings.grid.snap } })
  }

  useCommands(handlers)
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })
  useAgentBridge({
    store,
    camera,
    settings,
    handlers: handlersRef,
    web: webRuntime,
    desktops,
    save: file.save
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.key.startsWith('Arrow')) return
      const target = e.target as HTMLElement | null
      if (target?.isContentEditable || target?.closest('input, textarea, .cm-editor')) return
      const state = store.snapshot
      if (state.selection.size === 0 || state.activeNodeId) return
      e.preventDefault()
      const step = e.shiftKey ? settings.grid.size : NUDGE
      const delta: Point = {
        x: e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
        y: e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
      }
      store.mutate('сдвиг стрелками', (doc) => moveNodes(doc, state.selection, delta))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [store, settings.grid.size])

  const commandEnabled = useMemo<Record<string, boolean>>(
    () => ({
      'edit.undo': docState.canUndo,
      'edit.redo': docState.canRedo,
      'edit.cut': docState.selection.size > 0,
      'edit.copy': docState.selection.size > 0,
      'edit.delete': docState.selection.size + docState.edgeSelection.size > 0,
      'edit.duplicate': docState.selection.size > 0,
      'create.group': docState.selection.size > 0,
      'create.ungroup': docState.doc.nodes.some((n) => docState.selection.has(n.id) && n.type === 'group'),
      'view.zoomSelection': docState.selection.size > 0,
      'edit.resetSize': docState.doc.nodes.some((n) => docState.selection.has(n.id) && n.type === 'file'),
      ...Object.fromEntries(
        ['node.rename', 'node.role'].map((id) => [
          id,
          docState.selection.size === 1 &&
            docState.doc.nodes.some((n) => docState.selection.has(n.id) && isNameable(n))
        ])
      ),
      ...Object.fromEntries(
        ['none', '1', '2', '3', '4', '5', '6'].map((v) => [
          `color.${v}`,
          docState.selection.size + docState.edgeSelection.size > 0
        ])
      ),
      'arrange.front': docState.selection.size > 0,
      'arrange.back': docState.selection.size > 0,
      'arrange.forward': docState.selection.size > 0,
      'arrange.backward': docState.selection.size > 0,
      ...Object.fromEntries(
        [
          'align.left',
          'align.centerX',
          'align.right',
          'align.top',
          'align.centerY',
          'align.bottom',
          'align.distributeX',
          'align.distributeY',
          'align.sameWidth',
          'align.sameHeight',
          'align.sameSize',
          'align.packRow',
          'align.packGrid'
        ].map((id) => [id, docState.selection.size > 1])
      )
    }),
    [docState]
  )

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onMenu = (e: MouseEvent): void => {
      e.preventDefault()
      const nodeEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest?.(
        '[data-node-id]'
      )
      const id = nodeEl?.getAttribute('data-node-id') ?? null
      if (id && !store.snapshot.selection.has(id)) store.selectNodes([id], 'replace')
      const onNode = id !== null || store.snapshot.selection.size > 0
      setMenuState({
        x: e.clientX,
        y: e.clientY,
        commandIds: onNode
          ? [
              'edit.cut',
              'edit.copy',
              'edit.duplicate',
              'edit.delete',
              '-',
              'node.rename',
              'node.role',
              '-',
              'create.group',
              'create.ungroup',
              '-',
              'arrange.front',
              'arrange.forward',
              'arrange.backward',
              'arrange.back',
              '-',
              'align.left',
              'align.centerX',
              'align.right',
              'align.top',
              'align.centerY',
              'align.bottom',
              '-',
              'align.distributeX',
              'align.distributeY',
              'align.sameSize',
              '-',
              'color.none',
              'color.1',
              'color.2',
              'color.3',
              'color.4',
              'color.5',
              'color.6',
              '-',
              'edit.resetSize',
              'view.zoomSelection'
            ]
          : [
              'create.text',
              'create.web',
              'create.file',
              'create.terminal',
              'create.agent',
              '-',
              'edit.paste',
              'selection.all',
              '-',
              'view.zoomFit',
              'view.toggleGrid',
              'view.settings'
            ]
      })
    }
    el.addEventListener('contextmenu', onMenu)
    return () => el.removeEventListener('contextmenu', onMenu)
  }, [store])

  useEffect(() => {
    const enabled: Record<string, boolean> = {
      'edit.undo': docState.canUndo,
      'edit.redo': docState.canRedo,
      'edit.delete': docState.selection.size > 0,
      'edit.duplicate': docState.selection.size > 0,
      'view.zoomSelection': docState.selection.size > 0
    }
    window.api.menu.setEnabled(enabled)
  }, [docState.canUndo, docState.canRedo, docState.selection])

  const env = useMemo(
    () => ({ store, camera, settings, viewState: file.viewState }),
    [store, camera, settings, file.viewState]
  )

  const lowDetail = cam.zoom < settings.nodes.lodZoomThreshold

  return (
    <CanvasEnvContext.Provider value={env}>
      <WebRuntimeContext.Provider value={webRuntime}>
        <WebLiveContext.Provider value={liveIds}>
          <div className="app">
            <div className="app__main">
              <CanvasView
                camera={camera}
                viewportRef={viewportRef}
                showGrid={settings.grid.show}
                gridSize={settings.grid.size}
                wheelZooms={settings.camera.wheelZooms}
                zoomSpeed={settings.camera.zoomSpeed}
                overlay={
                  <InteractionOverlay
                    camera={camera}
                    doc={docState.doc}
                    selection={docState.selection}
                    edgeSelection={docState.edgeSelection}
                    hoveredId={hoveredId}
                    activeNodeId={docState.activeNodeId}
                    marquee={marquee}
                    autoSides={settings.edges.autoSides}
                    guides={guides}
                    draft={draft}
                  />
                }
              >
                <EdgesLayer
                  doc={docState.doc}
                  autoSides={settings.edges.autoSides}
                  selection={docState.edgeSelection}
                  editingId={editingEdge}
                  onEditLabel={setEditingEdge}
                />
                <NodesLayer
                  nodes={docState.doc.nodes}
                  selection={docState.selection}
                  activeNodeId={docState.activeNodeId}
                  visible={visible}
                  lowDetail={lowDetail}
                  keepMounted={keepMounted}
                  refs={nodeRefs}
                />
              </CanvasView>
              <CreateBar camera={camera} viewportRef={viewportRef} sizeOf={sizeOf} onCreate={createFromBar} />
              <DesktopBar doc={docState.doc} current={desktops.current} onSwitch={desktops.switchTo} />
              <Hud
                camera={camera}
                onFitAll={() => handlers['view.zoomFit']?.()}
                onFitSelection={() => handlers['view.zoomSelection']?.()}
                canFitSelection={docState.selection.size > 0}
              />
              {file.conflict && (
                <ConflictDialog change={file.conflict} onChoose={(c) => void file.resolveConflict(c)} />
              )}
              {file.error && <div className="banner banner--error">{file.error}</div>}
              {editingEdge && (
                <EdgeLabelEditor
                  initial={docState.doc.edges.find((e) => e.id === editingEdge)?.label ?? ''}
                  onCancel={() => setEditingEdge(null)}
                  onSubmit={(label) => {
                    const id = editingEdge
                    setEditingEdge(null)
                    store.mutate('подпись связи', (doc) =>
                      patchEdge(doc, id, label ? { label } : { label: undefined })
                    )
                  }}
                />
              )}
              {menuState && (
                <ContextMenu
                  state={menuState}
                  enabled={commandEnabled}
                  onRun={(id) => handlers[id]?.()}
                  onClose={() => setMenuState(null)}
                />
              )}
              {selectedImage && !eyedropper && (
                <ImageColorPanel camera={camera} node={selectedImage} onPick={() => setEyedropper(true)} />
              )}
              {selectedText && <TextFontPanel camera={camera} node={selectedText} />}
              {selectedImage && eyedropper && (
                <EyedropperOverlay
                  camera={camera}
                  node={selectedImage}
                  onClose={() => setEyedropper(false)}
                />
              )}
              {croppingNode && (
                <CropEditor camera={camera} node={croppingNode} onClose={() => setCropping(null)} />
              )}
              {settingsOpen && <SettingsPanel settings={settings} onClose={() => setSettingsOpen(false)} />}
              {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
              {urlPrompt && (
                <UrlPrompt
                  onCancel={() => setUrlPrompt(null)}
                  onSubmit={(url) => {
                    setUrlPrompt(null)
                    createWebNode(url, urlPrompt)
                  }}
                />
              )}
              {namePrompt && (
                <NodeNamePrompt {...namePrompt} store={store} onClose={() => setNamePrompt(null)} />
              )}
            </div>
          </div>
        </WebLiveContext.Provider>
      </WebRuntimeContext.Provider>
    </CanvasEnvContext.Provider>
  )
}

/** Диалог имени или роли терминала, агента или страницы. */
function NodeNamePrompt({
  nodeId,
  field,
  store,
  onClose
}: {
  nodeId: string
  field: 'name' | 'role'
  store: DocStore
  onClose(): void
}): React.JSX.Element | null {
  const node = store.doc.nodes.find((n) => n.id === nodeId)
  if (!node) return null
  const isName = field === 'name'
  return (
    <TextPrompt
      title={isName ? 'Имя' : 'Роль — кто это и чем занят (видна агентам)'}
      initial={(isName ? nodeName(node) : nodeRole(node)) ?? ''}
      placeholder={isName ? 'Задумчивый Аркадий' : 'ревьюер, пишет тесты…'}
      allowEmpty={!isName}
      onCancel={onClose}
      onSubmit={(value) => {
        onClose()
        const taken = store.doc.nodes.some((n) => n.id !== nodeId && nodeName(n) === value)
        // Занятое имя молча не берём: уникальность нужна агентам, чтобы находить соседей.
        if (isName && taken) return
        store.mutate(isName ? 'имя' : 'роль', (doc) =>
          replaceNodes(
            doc,
            new Map(
              doc.nodes
                .filter((n) => n.id === nodeId)
                .map((n) => [n.id, isName ? withNodeName(n, value) : withNodeRole(n, value)])
            )
          )
        )
      }}
    />
  )
}
