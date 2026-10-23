import { useCallback, useEffect, useRef, useState } from 'react'
import { fitRect, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { unionRects } from '@core/geometry'
import { nodeRect } from '@core/document'
import { desktopAtX, desktopOrigin, moveToDesktop, nodesOnDesktop } from '@core/desktops'
import type { DesktopCamerasApi } from './useCanvasFile'

export interface DesktopsApi {
  /** Стол, на который сейчас смотрит камера. */
  current: number
  currentRef: { readonly current: number }
  switchTo(desktop: number): void
  moveSelectionTo(desktop: number): void
  /** Камера, с которой смотреть на стол: запомненная, по его содержимому или на его начало. */
  cameraFor(desktop: number): Camera
}

/** Стол под центром экрана. */
const cameraDesktop = (camera: CameraController, cam: Camera = camera.value): number =>
  desktopAtX((camera.viewportSize.width / 2 - cam.x) / cam.zoom)

/**
 * Столы целиком выводятся из камеры: какой стол в центре экрана — тот и текущий. Когда
 * камера переезжает на другой стол (хоткей, zoom_to агента), последний её вид на старом
 * столе запоминается — вернёшься туда же, где был.
 */
export function useDesktops(
  store: DocStore,
  camera: CameraController,
  cameras: DesktopCamerasApi
): DesktopsApi {
  const [current, setCurrent] = useState(1)
  const currentRef = useRef(1)
  const camerasRef = useRef(cameras)
  useEffect(() => {
    camerasRef.current = cameras
  })

  useEffect(() => {
    // Если камера уже не на первом столе — первый же кадр это заметит и поправит `current`.
    let last = { desktop: currentRef.current, cam: camera.value }
    return camera.subscribeFrame((cam) => {
      const desktop = cameraDesktop(camera, cam)
      if (desktop === last.desktop) {
        last = { desktop, cam }
        return
      }
      // Нулевая камера — это вид до загрузки файла, а не место, где человек был: не затираем им.
      const pristine = last.cam.x === 0 && last.cam.y === 0 && last.cam.zoom === 1
      if (!pristine) camerasRef.current.set(last.desktop, last.cam)
      last = { desktop, cam }
      currentRef.current = desktop
      setCurrent(desktop)
    })
  }, [camera])

  const cameraFor = useCallback(
    (desktop: number): Camera => {
      const saved = camerasRef.current.get(desktop)
      if (saved && cameraDesktop(camera, saved) === desktop) return saved
      const { width, height } = camera.viewportSize
      const bounds = unionRects(nodesOnDesktop(store.doc, desktop).map(nodeRect))
      if (bounds) {
        const fit = fitRect(bounds, camera.viewportSize)
        if (fit.zoom <= 1) return fit
        // Пара мелких карточек не повод зумить в 4 раза — ставим их в центр на 100 %.
        return {
          zoom: 1,
          x: width / 2 - (bounds.x + bounds.width / 2),
          y: height / 2 - (bounds.y + bounds.height / 2)
        }
      }
      const origin = desktopOrigin(desktop)
      return { zoom: 1, x: width / 2 - origin.x, y: height / 2 - origin.y }
    },
    [camera, store]
  )

  const switchTo = useCallback(
    (desktop: number) => {
      if (desktop === currentRef.current) return
      store.setActiveNode(null)
      store.clearSelection()
      camera.set(cameraFor(desktop))
    },
    [camera, store, cameraFor]
  )

  const moveSelectionTo = useCallback(
    (desktop: number) => {
      const ids = store.snapshot.selection
      if (ids.size === 0 || desktop === currentRef.current) return
      store.mutate(`на стол ${desktop}`, (doc) => moveToDesktop(doc, ids, desktop))
      store.clearSelection()
    },
    [store]
  )

  return { current, currentRef, switchTo, moveSelectionTo, cameraFor }
}
