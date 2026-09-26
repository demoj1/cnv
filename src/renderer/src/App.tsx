import { useEffect, useMemo, useState } from 'react'
import { CameraController } from '@core/camera-controller'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { WorkspaceInfo } from '@shared/api'
import { CanvasView } from './canvas/CanvasView'
import { Hud } from './ui/Hud'
import { useCommands } from './commands/useCommands'
import { useTheme } from './ui/useTheme'

export function App(): React.JSX.Element {
  const camera = useMemo(() => new CameraController(), [])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)

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

  useEffect(() => () => camera.dispose(), [camera])

  useCommands({
    'workspace.open': () => void window.api.workspace.choose().then(setWorkspace),
    'view.zoomReset': () => camera.zoomToCenter(1),
    'view.zoomIn': () => camera.zoomToCenter(camera.value.zoom * 1.25),
    'view.zoomOut': () => camera.zoomToCenter(camera.value.zoom / 1.25),
    'view.zoomFit': () => camera.set({ x: 0, y: 0, zoom: 1 }),
    'view.toggleGrid': () => void window.api.settings.patch({ grid: { show: !settings.grid.show } }),
    'view.toggleSnap': () => void window.api.settings.patch({ grid: { snap: !settings.grid.snap } })
  })

  return (
    <div className="app">
      <div className="app__main">
        <CanvasView
          camera={camera}
          showGrid={settings.grid.show}
          gridSize={settings.grid.size}
          wheelZooms={settings.camera.wheelZooms}
          zoomSpeed={settings.camera.zoomSpeed}
        />
        <Hud camera={camera} />
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
  )
}
