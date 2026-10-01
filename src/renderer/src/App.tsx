import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CameraController } from '@core/camera-controller'
import { DocStore } from '@core/doc-store'
import { docBounds, nodeRect, type DocNode } from '@core/document'
import { nodeKind } from '@core/node-kind'
import { visualBounds } from '@core/image-edit'
import { isTerminal } from '@core/terminal'
import type { Point, Rect } from '@core/geometry'
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
  insertNodes,
  makeNode,
  moveNodes,
  patchEdge,
  patchNodes,
  reorderNodes,
  ungroup
} from '@core/ops'
import { DEFAULT_SETTINGS, UI_SCALES, type Settings } from '@shared/settings'
import { CanvasView } from './canvas/CanvasView'
import { CanvasEnvContext } from './canvas/env'
import { NodesLayer } from './canvas/NodesLayer'
import { InteractionOverlay } from './canvas/InteractionOverlay'
import { CropEditor } from './canvas/CropEditor'
import { ImageColorPanel } from './canvas/ImageColorPanel'
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
import { useClipboardAndDrop } from './workspace/useClipboardAndDrop'
import { WebLiveContext, WebRuntimeContext } from './web/context'
import { useWebLifecycle } from './web/useWebLifecycle'
import { UrlPrompt } from './ui/UrlPrompt'
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
  useAutoEdgeSides(store, settings.edges.autoSides)
  const clipboard = useClipboardAndDrop(store, camera, settings, viewportRef)
  const { runtime: webRuntime, liveIds } = useWebLifecycle(store, camera, settings)
  const [urlPrompt, setUrlPrompt] = useState(false)
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

  const createWebNode = useCallback(
    (url: string, near?: DocNode) => {
      const size = settings.nodes.defaultWebSize
      const spot = near
        ? { x: near.x + near.width + 40, y: near.y }
        : (() => {
            const v = camera.visibleRect()
            return {
              x: Math.round(v.x + v.width / 2 - size.width / 2),
              y: Math.round(v.y + v.height / 2 - size.height / 2)
            }
          })()
      store.mutate('веб-нода', (doc) =>
        insertNodes(doc, [
          makeNode({ type: 'link', url }, { ...spot, width: size.width, height: size.height })
        ])
      )
    },
    [store, camera, settings]
  )

  useEffect(
    () =>
      window.api.web.onGuestWindowOpen(({ url }) => {
        const active = store.snapshot.activeNodeId
        const near = active ? store.doc.nodes.find((n) => n.id === active) : undefined
        createWebNode(url, near)
      }),
    [store, createWebNode]
  )

  useEffect(() => () => camera.dispose(), [camera])

  const createTextAt = useCallback(
    (world: Point) => {
      const size = settings.nodes.defaultTextSize
      store.mutate('новая карточка', (doc) =>
        insertNodes(doc, [
          makeNode(
            { type: 'text', text: '' },
            {
              x: Math.round(world.x - size.width / 2),
              y: Math.round(world.y - size.height / 2),
              width: size.width,
              height: size.height
            }
          )
        ])
      )
      const created = store.doc.nodes[store.doc.nodes.length - 1]
      if (created) {
        store.selectNodes([created.id])
        store.setActiveNode(created.id)
      }
    },
    [store, settings]
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
    'create.web': () => setUrlPrompt(true),
    'create.group': () => {
      store.mutate('группировка', (doc) => {
        const result = groupSelection(doc, docState.selection, 24, 'Группа', settings.nodes.minSize)
        return result ? result.doc : doc
      })
    },
    'create.ungroup': () => store.mutate('разгруппировка', (doc) => ungroup(doc, docState.selection)),
    ...alignHandlers,
    'create.text': () => {
      const v = camera.visibleRect()
      createTextAt({ x: v.x + v.width / 2, y: v.y + v.height / 2 })
    },
    'create.terminal': () => {
      void window.api.terminal.defaultShell().then((fallback) => {
        const shell = settings.terminal.shell || fallback
        const size = { width: 720, height: 420 }
        const v = camera.visibleRect()
        store.mutate('терминал', (doc) =>
          insertNodes(doc, [
            makeNode(
              { type: 'terminal', shell: shell.split('/').pop() ?? shell },
              {
                x: v.x + v.width / 2 - size.width / 2,
                y: v.y + v.height / 2 - size.height / 2,
                ...size
              }
            )
          ])
        )
      })
    },
    'arrange.front': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'front')),
    'arrange.back': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'back')),
    'arrange.forward': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'forward')),
    'arrange.backward': () => store.mutate('порядок', (d) => reorderNodes(d, docState.selection, 'backward')),
    'view.zoomReset': () => camera.zoomToCenter(1),
    'view.zoomIn': () => camera.zoomToCenter(camera.value.zoom * 1.25),
    'view.zoomOut': () => camera.zoomToCenter(camera.value.zoom / 1.25),
    'view.zoomFit': () => {
      const bounds = docBounds(docState.doc)
      if (bounds) camera.fit(bounds)
    },
    'view.zoomSelection': () => camera.fitAll(selectedRects),
    'view.settings': () => setSettingsOpen(true),
    'view.uiScaleUp': () => shiftUiScale(settings.uiScale, 1),
    'view.uiScaleDown': () => shiftUiScale(settings.uiScale, -1),
    'help.shortcuts': () => setHelpOpen(true),
    'create.file': () => {
      void window.api.files.choose().then(async (paths) => {
        for (const source of paths) {
          const imported = await window.api.attachments.importPath(source)
          const v = camera.visibleRect()
          store.mutate('файл', (doc) =>
            insertNodes(doc, [
              makeNode(
                { type: 'file', file: imported.relPath },
                {
                  x: Math.round(v.x + v.width / 2),
                  y: Math.round(v.y + v.height / 2),
                  width: 400,
                  height: 300
                }
              )
            ])
          )
        }
      })
    },
    'view.toggleGrid': () => void window.api.settings.patch({ grid: { show: !settings.grid.show } }),
    'view.toggleSnap': () => void window.api.settings.patch({ grid: { snap: !settings.grid.snap } })
  }

  useCommands(handlers)

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
                  onCancel={() => setUrlPrompt(false)}
                  onSubmit={(url) => {
                    setUrlPrompt(false)
                    createWebNode(url)
                  }}
                />
              )}
            </div>
          </div>
        </WebLiveContext.Provider>
      </WebRuntimeContext.Provider>
    </CanvasEnvContext.Provider>
  )
}
