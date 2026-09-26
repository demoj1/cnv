import { useLayoutEffect, useRef } from 'react'
import type { Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'

interface Props {
  camera: CameraController
  size: number
}

/** Ниже этого шага в экранных пикселях точки сливаются — переходим на следующий уровень. */
const MIN_SCREEN_STEP = 12

export function GridLayer({ camera, size }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const paint = (cam: Camera): void => {
      let step = size * cam.zoom
      while (step > 0 && step < MIN_SCREEN_STEP) step *= 4
      const major = step * 5
      const ox = cam.x % step
      const oy = cam.y % step
      const mox = cam.x % major
      const moy = cam.y % major
      el.style.backgroundImage =
        'radial-gradient(circle at center, var(--grid-line) 1px, transparent 1px),' +
        'radial-gradient(circle at center, var(--grid-dot) 1.4px, transparent 1.4px)'
      el.style.backgroundSize = `${step}px ${step}px, ${major}px ${major}px`
      el.style.backgroundPosition = `${ox}px ${oy}px, ${mox}px ${moy}px`
    }
    paint(camera.value)
    return camera.subscribeRaw(paint)
  }, [camera, size])

  return <div className="grid" ref={ref} />
}
