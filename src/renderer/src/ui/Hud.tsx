import type { CameraController } from '@core/camera-controller'
import { useCameraValue } from '@renderer/canvas/useCameraValue'

interface Props {
  camera: CameraController
}

export function Hud({ camera }: Props): React.JSX.Element {
  const cam = useCameraValue(camera)
  return (
    <div className="hud">
      <button type="button" title="Уменьшить" onClick={() => camera.zoomToCenter(cam.zoom / 1.25)}>
        −
      </button>
      <button type="button" className="hud__zoom" title="Масштаб 100%" onClick={() => camera.zoomToCenter(1)}>
        {Math.round(cam.zoom * 100)}%
      </button>
      <button type="button" title="Увеличить" onClick={() => camera.zoomToCenter(cam.zoom * 1.25)}>
        +
      </button>
    </div>
  )
}
