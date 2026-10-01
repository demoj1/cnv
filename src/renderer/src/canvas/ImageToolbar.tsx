import { useLayoutEffect, useRef } from 'react'
import { worldToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { imageEdit, normalizeAngle, rotatedAABB, withImageEdit } from '@core/image-edit'
import { patchNodes } from '@core/ops'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
}

/** Отступ панели над верхом габаритной коробки картинки — в экранных пикселях. */
const TOOLBAR_GAP = 12

/**
 * Мини-тулбар выделенной картинки. Пока — повороты на ±90°; сюда же лягут кроп и пипетка
 * (фазы 3–4). Панель горизонтальна и не крутится вместе с картинкой, поэтому висит над
 * AABB повёрнутой ноды, а не над её наклонным краем.
 */
export function ImageToolbar({ camera, node }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { store } = useCanvasEnv()
  const angle = imageEdit(node)?.rotate ?? 0
  const aabb = rotatedAABB(nodeRect(node), angle)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const paint = (cam: Camera): void => {
      const top = worldToScreen(cam, { x: aabb.x + aabb.width / 2, y: aabb.y })
      el.style.left = `${top.x}px`
      el.style.top = `${top.y - TOOLBAR_GAP}px`
    }
    paint(camera.value)
    return camera.subscribeRaw(paint)
  }, [camera, aabb.x, aabb.y, aabb.width])

  const rotateBy = (delta: number): void => {
    store.mutate('поворот на 90°', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      const next = normalizeAngle((imageEdit(n)?.rotate ?? 0) + delta)
      return patchNodes(doc, new Map([[node.id, { extra: withImageEdit(n.extra, { rotate: next }) }]]))
    })
  }

  return (
    <div className="image-toolbar" ref={ref}>
      <button type="button" title="Повернуть влево на 90°" onClick={() => rotateBy(-90)}>
        ⟲
      </button>
      <button type="button" title="Повернуть вправо на 90°" onClick={() => rotateBy(90)}>
        ⟳
      </button>
    </div>
  )
}
