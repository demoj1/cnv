import { useLayoutEffect, useRef, useState } from 'react'
import { worldToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { imageEdit, nodeRotate, rotatedAABB, withImageEdit, type ColorKey } from '@core/image-edit'
import { patchNodes } from '@core/ops'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
  onPick(): void
}

/** Отступ панели под нижним краем габаритной коробки — в экранных пикселях. */
const GAP = 14

/**
 * Панель маски по цвету под выделенной картинкой: пипетка добавляет цвет, чипы его
 * показывают и удаляют, слайдер крутит допуск сразу у всех. Висит снизу, чтобы не лезть на
 * гизмо поворота сверху.
 */
export function ImageColorPanel({ camera, node, onPick }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const keys = imageEdit(node)?.colorKeys ?? []
  const aabb = rotatedAABB(nodeRect(node), nodeRotate(node))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const paint = (cam: Camera): void => {
      const p = worldToScreen(cam, { x: aabb.x + aabb.width / 2, y: aabb.y + aabb.height })
      el.style.left = `${p.x}px`
      el.style.top = `${p.y + GAP}px`
    }
    paint(camera.value)
    return camera.subscribeRaw(paint)
  }, [camera, aabb.x, aabb.y, aabb.width, aabb.height])

  const writeKeys = (next: ColorKey[]): void => {
    store.mutate('маска по цвету', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      return patchNodes(doc, new Map([[node.id, { extra: withImageEdit(n.extra, { colorKeys: next }) }]]))
    })
  }

  const removeAt = (i: number): void => writeKeys(keys.filter((_, idx) => idx !== i))
  const setTolerance = (t: number): void => writeKeys(keys.map((k) => ({ ...k, tolerance: t })))
  const tolerance = keys[0]?.tolerance ?? 0.12

  // Свёрнуто — одна компактная кнопка (сюда позже лягут и другие действия над картинкой).
  if (!open) {
    return (
      <div className="color-panel color-panel--collapsed" ref={ref}>
        <button
          type="button"
          className="color-panel__toggle"
          title="Действия с картинкой"
          onClick={() => setOpen(true)}
        >
          🎨{keys.length > 0 ? ` ${keys.length}` : ''}
        </button>
      </div>
    )
  }

  return (
    <div className="color-panel" ref={ref}>
      <button type="button" className="color-panel__pick" title="Вырезать цвет пипеткой" onClick={onPick}>
        💧 Вырезать цвет
      </button>
      {keys.map((k, i) => (
        <button
          key={`${k.color}-${i}`}
          type="button"
          className="color-panel__chip"
          title={`${k.color} — убрать`}
          onClick={() => removeAt(i)}
        >
          <span className="color-panel__swatch" style={{ background: k.color }} />✕
        </button>
      ))}
      {keys.length > 0 && (
        <label className="color-panel__tol" title="Допуск">
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
        </label>
      )}
      <button
        type="button"
        className="color-panel__close"
        title="Свернуть"
        onClick={() => setOpen(false)}
      >
        ✕
      </button>
    </div>
  )
}
