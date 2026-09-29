import { useEffect, type RefObject } from 'react'
import type { CameraController } from '@core/camera-controller'

interface Options {
  wheelZooms: boolean
  zoomSpeed: number
}

const PAN_BUTTON_MIDDLE = 1
/** Делитель чувствительности зума: подобран так, что один щелчок мыши — заметный, но не резкий шаг. */
const ZOOM_DIVISOR = 300
/** Высота «строки» для колеса в режиме строк (мышь), чтобы шаг совпадал с пиксельным (тачпад). */
const LINE_PX = 16
/**
 * Инерция тачпада может выстрелить огромной дельтой за одно событие — без потолка это
 * телепорт масштаба. За один тик меняем зум не больше чем вдвое.
 */
const MAX_ZOOM_STEP = 2

/**
 * Колесо приходит в разных единицах: тачпад — пиксели (`deltaMode` 0), мышь порой строки
 * (1) или страницы (2). Приводим к пикселям, чтобы жест ощущался одинаково с любого
 * устройства.
 */
function pixelDelta(e: WheelEvent, el: HTMLElement): { x: number; y: number } {
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? el.clientHeight : 1
  return { x: e.deltaX * k, y: e.deltaY * k }
}

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
      // Колесо, рождённое внутри ноды, которая забрала мышь себе, принадлежит ей:
      // терминалу — скроллбэк, PDF — прокрутка, редактору — текст. Без этого, когда
      // прокручивать нечего, событие всплывает сюда и холст едет прямо под руками.
      if ((e.target as Element | null)?.closest?.('[data-owns-input]')) return
      e.preventDefault()
      camera.markInteraction()
      const { x: dx, y: dy } = pixelDelta(e, el)
      // Щипок тачпада Chromium присылает как Ctrl+колесо — это зум к курсору. Two-finger
      // scroll и обычное колесо — панорама. wheelZooms превращает обычное колесо в зум.
      if (e.ctrlKey || e.metaKey || options.wheelZooms) {
        const raw = Math.exp((-dy * options.zoomSpeed) / ZOOM_DIVISOR)
        const factor = Math.min(MAX_ZOOM_STEP, Math.max(1 / MAX_ZOOM_STEP, raw))
        camera.zoomBy(localPoint(e), factor)
        return
      }
      // Shift+колесо мыши даёт только вертикальную дельту — пускаем её по горизонтали.
      if (e.shiftKey) camera.pan(-dy - dx, 0)
      else camera.pan(-dx, -dy)
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
