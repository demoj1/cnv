import type { CameraController } from '@core/camera-controller'
import { useCameraValue } from '@renderer/canvas/useCameraValue'

interface Props {
  camera: CameraController
  onFitAll(): void
  onFitSelection(): void
  canFitSelection: boolean
}

/** Иконка «вписать всё»: рамка с уголками, раздвигающимися наружу. */
function FitAllIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 5.5V2.5h3M14 5.5V2.5h-3M2 10.5v3h3M14 10.5v3h-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Иконка «вписать выделенное»: та же рамка, внутри залитый прямоугольник. */
function FitSelectionIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M2 5V2.5h2.5M14 5V2.5h-2.5M2 11v2.5h2.5M14 11v2.5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6" y="6" width="4" height="4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function Hud({ camera, onFitAll, onFitSelection, canFitSelection }: Props): React.JSX.Element {
  const cam = useCameraValue(camera)
  return (
    <div className="hud">
      <button type="button" className="hud__icon" title="Вписать всё (Shift+1)" onClick={onFitAll}>
        <FitAllIcon />
      </button>
      <button
        type="button"
        className="hud__icon"
        title="Вписать выделенное (Shift+2)"
        disabled={!canFitSelection}
        onClick={onFitSelection}
      >
        <FitSelectionIcon />
      </button>
      <span className="hud__sep" />
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
