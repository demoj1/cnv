import { useEffect, useMemo, useState } from 'react'
import { CameraController } from '@core/camera-controller'
import { DocStore } from '@core/doc-store'
import type { DocEdge, DocNode } from '@core/document'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { SnapshotPayload } from '@shared/snapshot'
import { CanvasView } from '../canvas/CanvasView'
import { CanvasEnvContext, type CanvasEnv } from '../canvas/env'
import { EdgesLayer } from '../canvas/EdgesLayer'
import { NodesLayer } from '../canvas/NodesLayer'
import { registerBuiltinNodeTypes } from '../nodes'
import { useTheme } from '../ui/useTheme'
import { useTerminalThemeRoot } from '../nodes/terminal-theme'

registerBuiltinNodeTypes()

const EMPTY = new Set<string>()
const NOOP = (): void => {}

/** Сколько ждать картинки, шрифты и PDF перед кадром. */
const SETTLE_MS = 400
const PDF_SETTLE_MS = 1500

/**
 * Скрытое окно снимка: холст только с переданными нодами, камера — ровно на прямоугольник,
 * без интерактива. Дорисовал — сказал main «готово», тот снял кадр и закрыл окно.
 */
export function SnapshotApp(): React.JSX.Element | null {
  const [payload, setPayload] = useState<SnapshotPayload | null>(null)
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const store = useMemo(() => new DocStore(), [])
  const camera = useMemo(() => new CameraController(), [])
  useTheme(settings.theme)
  useTerminalThemeRoot(settings.terminal.theme)

  useEffect(() => {
    void Promise.all([window.api.snapshot.payload(), window.api.settings.get()]).then(([p, s]) => {
      if (!p) return
      store.load({ nodes: p.nodes as DocNode[], edges: p.edges as DocEdge[], extra: {} })
      setSettings(s)
      setPayload(p)
    })
  }, [store])

  // Камера — на прямоугольник снимка, как только известен размер окна.
  useEffect(() => {
    if (!payload) return
    const { rect } = payload
    const place = (): void => {
      const zoom = window.innerWidth / rect.width
      camera.set({ zoom, x: -rect.x * zoom, y: -rect.y * zoom })
    }
    place()
    const hasPdf = (payload.nodes as DocNode[]).some((n) => n.type === 'file' && /\.pdf$/i.test(n.file))
    let cancelled = false
    void (async () => {
      await document.fonts.ready
      await new Promise((r) => setTimeout(r, SETTLE_MS))
      await Promise.all(
        [...document.images].map((img) =>
          img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true }))
        )
      )
      if (hasPdf) await new Promise((r) => setTimeout(r, PDF_SETTLE_MS))
      place()
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      if (!cancelled) window.api.snapshot.ready()
    })()
    return () => {
      cancelled = true
    }
  }, [payload, camera])

  const env = useMemo<CanvasEnv | null>(
    () =>
      payload && {
        store,
        camera,
        settings,
        viewState: { get: () => ({}), patch: NOOP },
        editIdentity: NOOP,
        editCard: NOOP,
        startEyedropper: NOOP,
        pickSession: NOOP,
        snapshot: { terminals: payload.terminals, web: payload.web }
      },
    [payload, store, camera, settings]
  )

  if (!payload || !env) return null
  const huge = { x: -1e9, y: -1e9, width: 2e9, height: 2e9 }
  return (
    <CanvasEnvContext.Provider value={env}>
      <div className="app app--snapshot">
        <div className="app__main">
          <CanvasView
            camera={camera}
            showGrid={settings.grid.show}
            gridSize={settings.grid.size}
            wheelZooms={false}
            zoomSpeed={settings.camera.zoomSpeed}
          >
            <EdgesLayer
              doc={store.doc}
              autoSides={settings.edges.autoSides}
              selection={EMPTY}
              editingId={null}
              onEditLabel={NOOP}
            />
            <NodesLayer
              nodes={store.doc.nodes}
              selection={EMPTY}
              activeNodeId={null}
              visible={huge}
              lowDetail={false}
              keepMounted={EMPTY}
              refs={new Map()}
            />
          </CanvasView>
        </div>
      </div>
    </CanvasEnvContext.Provider>
  )
}
