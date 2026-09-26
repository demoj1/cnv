import { useEffect, type RefObject } from 'react'
import type { CameraController } from '@core/camera-controller'

interface Options {
  wheelZooms: boolean
  zoomSpeed: number
}

const PAN_BUTTON_MIDDLE = 1

export function useCameraInteractions(
  viewportRef: RefObject<HTMLElement | null>,
  camera: CameraController,
  options: Options
): void {
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    let spaceDown = false
    let panning = false
    let pointerId: number | null = null
    let lastX = 0
    let lastY = 0

    const localPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const rect = el.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      camera.markInteraction()
      const zoomGesture = e.ctrlKey || e.metaKey || options.wheelZooms
      if (zoomGesture) {
        const factor = Math.exp((-e.deltaY * options.zoomSpeed) / 300)
        camera.zoomBy(localPoint(e), factor)
        return
      }
      if (e.shiftKey) camera.pan(-e.deltaY - e.deltaX, 0)
      else camera.pan(-e.deltaX, -e.deltaY)
    }

    const startPan = (e: PointerEvent): void => {
      panning = true
      pointerId = e.pointerId
      lastX = e.clientX
      lastY = e.clientY
      el.setPointerCapture(e.pointerId)
      el.classList.add('viewport--panning')
    }

    const stopPan = (): void => {
      if (pointerId !== null && el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
      panning = false
      pointerId = null
      el.classList.remove('viewport--panning')
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button === PAN_BUTTON_MIDDLE || (e.button === 0 && spaceDown)) {
        e.preventDefault()
        startPan(e)
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== pointerId) return
      camera.markInteraction()
      camera.pan(e.clientX - lastX, e.clientY - lastY)
      lastX = e.clientX
      lastY = e.clientY
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) stopPan()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target?.isContentEditable || target?.closest('input, textarea, .cm-editor')) return
      spaceDown = true
      el.classList.add('viewport--pannable')
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      spaceDown = false
      el.classList.remove('viewport--pannable')
      if (panning) stopPan()
    }

    const onBlur = (): void => {
      spaceDown = false
      el.classList.remove('viewport--pannable')
      if (panning) stopPan()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [viewportRef, camera, options.wheelZooms, options.zoomSpeed])
}
