import { useSyncExternalStore } from 'react'
import type { Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'

/** Значение камеры для React — не чаще раза за кадр, чтобы pan/zoom не гонял дерево. */
export function useCameraValue(camera: CameraController): Camera {
  return useSyncExternalStore(
    (cb) => camera.subscribeFrame(cb),
    () => camera.value
  )
}
