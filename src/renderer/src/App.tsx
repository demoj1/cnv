import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CameraController } from '@core/camera-controller'
import { DocStore } from '@core/doc-store'
import { docBounds, nodeRect } from '@core/document'
import type { Point } from '@core/geometry'
import { deleteEntities, duplicateSubgraph, insertNodes, makeNode, moveNodes, reorderNodes } from '@core/ops'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { WorkspaceInfo } from '@shared/api'
import { CanvasView } from './canvas/CanvasView'
import { CanvasEnvContext } from './canvas/env'
import { NodesLayer } from './canvas/NodesLayer'
import { SelectionOverlay } from './canvas/SelectionOverlay'
import { useCanvasInteractions, type MarqueeState } from './canvas/useCanvasInteractions'
import { useCameraValue, useVisibleRect } from './canvas/useCameraValue'
import { useDocState } from './canvas/useDocState'
import { useCommands } from './commands/useCommands'
import { registerBuiltinNodeTypes } from './nodes'
import { Hud } from './ui/Hud'
import { Sidebar } from './ui/Sidebar'
import { ConflictDialog } from './ui/ConflictDialog'
import { useTheme } from './ui/useTheme'
import { useCanvasFile } from './workspace/useCanvasFile'

registerBuiltinNodeTypes()

const NUDGE = 1

export function App(): React.JSX.Element {
  const camera = useMemo(() => new CameraController(), [])
  const store = useMemo(() => new DocStore(), [])
  const nodeRefs = useMemo(() => new Map<string, HTMLElement>(), [])
  const viewportRef = useRef<HTMLDivElement>(null)

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const file = useCanvasFile(store, camera)

  const docState = useDocState(store)
  const cam = useCameraValue(camera)
  const visible = useVisibleRect(camera, window.innerHeight / 2)

  useTheme(settings.theme)

  useEffect(() => {
    void window.api.settings.get().then(setSettings)
    void window.api.workspace.current().then(setWorkspace)
    const offSettings = window.api.settings.onChanged(setSettings)
    const offWorkspace = window.api.workspace.onOpened(setWorkspace)
    return () => {
      offSettings()
      offWorkspace()
    }
  }, [])

  useEffect(() => window.api.canvas.onOpenRequest((relPath) => void file.open(relPath)), [file])

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
    onCreateTextAt: createTextAt
  })

  const selectedRects = useMemo(
    () => docState.doc.nodes.filter((n) => docState.selection.has(n.id)).map(nodeRect),
    [docState.doc, docState.selection]
  )

  useCommands({
    'workspace.open': () => void window.api.workspace.choose().then(setWorkspace),
    'canvas.new': () => {
      void window.api.canvas.create('Новый канвас').then((info) => file.open(info.relPath))
    },
    'canvas.save': () => void file.save(),
    'canvas.close': () => file.close(),
    'view.toggleSidebar': () => setSidebarOpen((v) => !v),
    'edit.undo': () => store.undo(),
    'edit.redo': () => store.redo(),
    'edit.redoAlt': () => store.redo(),
    'edit.delete': () =>
      store.mutate('удаление', (doc) => deleteEntities(doc, docState.selection, docState.edgeSelection)),
    'edit.duplicate': () => {
      store.mutate('дублирование', (doc) => duplicateSubgraph(doc, docState.selection, { x: 24, y: 24 }).doc)
    },
    'selection.all': () => store.selectAll(),
    'selection.none': () => {
      if (store.snapshot.activeNodeId) store.setActiveNode(null)
      else store.clearSelection()
    },
    'create.text': () => {
      const v = camera.visibleRect()
      createTextAt({ x: v.x + v.width / 2, y: v.y + v.height / 2 })
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
    'view.toggleGrid': () => void window.api.settings.patch({ grid: { show: !settings.grid.show } }),
    'view.toggleSnap': () => void window.api.settings.patch({ grid: { snap: !settings.grid.snap } })
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

  const env = useMemo(() => ({ store, camera, settings }), [store, camera, settings])

  const lowDetail = cam.zoom < settings.nodes.lodZoomThreshold

  return (
    <CanvasEnvContext.Provider value={env}>
      <div className="app">
        {sidebarOpen && (
          <Sidebar
            workspace={workspace}
            current={file.relPath}
            onOpen={(relPath) => void file.open(relPath)}
            onChooseWorkspace={() => void window.api.workspace.choose().then(setWorkspace)}
          />
        )}
        <div className="app__main">
          <CanvasView
            camera={camera}
            viewportRef={viewportRef}
            showGrid={settings.grid.show}
            gridSize={settings.grid.size}
            wheelZooms={settings.camera.wheelZooms}
            zoomSpeed={settings.camera.zoomSpeed}
            overlay={
              <SelectionOverlay
                camera={camera}
                nodes={docState.doc.nodes}
                selection={docState.selection}
                marquee={marquee}
              />
            }
          >
            <NodesLayer
              nodes={docState.doc.nodes}
              selection={docState.selection}
              activeNodeId={docState.activeNodeId}
              visible={visible}
              lowDetail={lowDetail}
              refs={nodeRefs}
            />
          </CanvasView>
          <Hud camera={camera} />
          {file.conflict && (
            <ConflictDialog change={file.conflict} onChoose={(c) => void file.resolveConflict(c)} />
          )}
          {file.error && <div className="banner banner--error">{file.error}</div>}
          {workspace && !file.relPath && (
            <div className="empty-state">
              <div>Канвас не выбран</div>
              <button
                type="button"
                onClick={() =>
                  void window.api.canvas.create('Новый канвас').then((i) => file.open(i.relPath))
                }
              >
                Создать канвас
              </button>
            </div>
          )}
          {!workspace && (
            <div className="empty-state">
              <div>Папка-workspace не открыта</div>
              <button type="button" onClick={() => void window.api.workspace.choose().then(setWorkspace)}>
                Открыть папку…
              </button>
            </div>
          )}
        </div>
      </div>
    </CanvasEnvContext.Provider>
  )
}
