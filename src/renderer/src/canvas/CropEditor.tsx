import { useEffect, useRef, useState } from 'react'
import { screenToWorld, worldRectToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { imageEdit, normalizedCrop, uncroppedRect, withImageEdit } from '@core/image-edit'
import { patchNodes } from '@core/ops'
import type { Rect } from '@core/geometry'
import { RESIZE_HANDLES, resizeRect, type ResizeHandle } from '@core/transform'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
  onClose(): void
}

const MIN = { width: 24, height: 24 }
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 }

/** Прижимает `r` внутрь `bounds`, сохраняя размер (сдвиг), не меньше минимального. */
function clampInside(r: Rect, bounds: Rect): Rect {
  const width = Math.min(r.width, bounds.width)
  const height = Math.min(r.height, bounds.height)
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.width - width)
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.height - height)
  return { x, y, width, height }
}

/**
 * Под-режим кропа: показываем картинку целиком (неповёрнутой), поверх — рамка кадра с
 * ручками, вне её затемнено. Enter/клик по кнопке применяет, Esc отменяет. Кроп хранится
 * нормализованным к исходнику, поэтому не зависит от поворота.
 */
export function CropEditor({ camera, node, onClose }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const rootRef = useRef<HTMLDivElement>(null)
  // Замораживаем камеру на входе: режим модальный, незачем гоняться за панорамой/зумом.
  const [cam] = useState<Camera>(() => camera.value)

  const box = worldRectToScreen(cam, nodeRect(node))
  const crop = imageEdit(node)?.crop ?? FULL_CROP
  const full = uncroppedRect(box, crop)
  const [rect, setRect] = useState<Rect>(box)
  const src = window.api.files.url(node.type === 'file' ? node.file : '')

  const apply = (): void => {
    const topLeft = screenToWorld(cam, { x: rect.x, y: rect.y })
    const world = { x: topLeft.x, y: topLeft.y, width: rect.width / cam.zoom, height: rect.height / cam.zoom }
    const nextCrop = normalizedCrop(full, rect)
    store.mutate('кроп', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      return patchNodes(
        doc,
        new Map([
          [
            node.id,
            {
              x: world.x,
              y: world.y,
              width: world.width,
              height: world.height,
              extra: withImageEdit(n.extra, { crop: nextCrop, sized: true })
            }
          ]
        ])
      )
    })
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        apply()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onPointerDown = (e: React.PointerEvent): void => {
    const el = e.target as HTMLElement
    const handle = el.dataset.cropHandle as ResizeHandle | undefined
    const move = el.dataset.cropMove !== undefined
    if (!handle && !move) return
    e.preventDefault()
    e.stopPropagation()
    const root = rootRef.current
    if (root) root.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const origin = rect

    const onMove = (ev: PointerEvent): void => {
      const delta = { x: ev.clientX - start.x, y: ev.clientY - start.y }
      const next = handle
        ? resizeRect(origin, handle, delta, { minSize: MIN })
        : { ...origin, x: origin.x + delta.x, y: origin.y + delta.y }
      setRect(clampInside(next, full))
    }
    const onUp = (ev: PointerEvent): void => {
      if (root && root.hasPointerCapture(ev.pointerId)) root.releasePointerCapture(ev.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Четыре затемняющие панели вокруг рамки кадра (во весь экран).
  const dim = [
    { left: 0, top: 0, width: '100%', height: rect.y },
    { left: 0, top: rect.y + rect.height, width: '100%', bottom: 0 },
    { left: 0, top: rect.y, width: rect.x, height: rect.height },
    { left: rect.x + rect.width, top: rect.y, right: 0, height: rect.height }
  ]

  return (
    <div className="crop-editor" ref={rootRef} onPointerDown={onPointerDown}>
      <img
        className="crop-editor__img"
        src={src}
        alt=""
        draggable={false}
        style={{ left: full.x, top: full.y, width: full.width, height: full.height }}
      />
      {dim.map((s, i) => (
        <div key={i} className="crop-editor__dim" style={s as React.CSSProperties} />
      ))}
      <div
        className="crop-editor__frame"
        data-crop-move
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        {RESIZE_HANDLES.filter((h) => h.length === 2).map((h) => (
          <div key={h} className={`crop-handle crop-handle--${h}`} data-crop-handle={h} />
        ))}
      </div>
      <div className="crop-editor__bar">
        <button type="button" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="crop-editor__apply" onClick={apply}>
          Обрезать
        </button>
      </div>
    </div>
  )
}
