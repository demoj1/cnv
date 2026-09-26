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

/** Видимая область мира с запасом: пересчитывается и при смене камеры, и при ресайзе окна. */
export function useVisibleRect(camera: CameraController, padding: number): Rect {
  const version = useSyncExternalStore(
    (cb) => camera.subscribeFrame(cb),
    () => camera.version
  )
  return useMemo(
    () => camera.visibleRect(padding),
    // version — это и есть сигнал «камера или размер вьюпорта изменились»
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, padding, version]
  )
}
