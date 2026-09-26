import { useMemo, useSyncExternalStore } from 'react'
import type { Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { Rect } from '@core/geometry'

/** Значение камеры для React — не чаще раза за кадр, чтобы pan/zoom не гонял дерево. */
export function useCameraValue(camera: CameraController): Camera {
  return useSyncExternalStore(
    (cb) => camera.subscribeFrame(cb),
    () => camera.value
  )
}

/**
 * Видимая область мира с запасом. Координаты квантуются: иначе каждый кадр pan давал бы
 * новый прямоугольник, и список нод пересобирался бы на каждом пикселе.
 */
export function useVisibleRect(camera: CameraController, padding: number): Rect {
  const version = useSyncExternalStore(
    (cb) => camera.subscribeFrame(cb),
    () => camera.version
  )
  const raw = camera.visibleRect(padding)
  const step = Math.max(128, padding / 2)
  const key = [
    Math.floor(raw.x / step),
    Math.floor(raw.y / step),
    Math.ceil((raw.x + raw.width) / step),
    Math.ceil((raw.y + raw.height) / step)
  ].join(':')
  void version
  return useMemo(() => {
    const [x0, y0, x1, y1] = key.split(':').map(Number) as [number, number, number, number]
    return { x: x0 * step, y: y0 * step, width: (x1 - x0) * step, height: (y1 - y0) * step }
  }, [key, step])
}
