import { useLayoutEffect, useRef, useState } from 'react'
import { worldToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { nodeRotate, rotatedAABB } from '@core/image-edit'
import { nodeActions } from '@renderer/nodes/actions'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
}

/** Отступ панели под нижним краем габаритной коробки — в экранных пикселях. */
const GAP = 14

/**
 * Панель под выделенной нодой — для нод без своей шапки (карточка, картинка, файл, PDF,
 * группа). Секции — из реестра действий (`nodes/actions.ts`): свёрнутая панель — одна
 * кнопка со сводкой всех действий, раскрытая — их виджеты в ряд. Висит снизу, чтобы не лезть
 * на гизмо поворота сверху.
 */
export function NodePanel({ camera, node }: Props): React.JSX.Element | null {
  const env = useCanvasEnv()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const aabb = rotatedAABB(nodeRect(node), nodeRotate(node))
  const actions = nodeActions(node, 'panel')

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
  }, [camera, aabb.x, aabb.y, aabb.width, aabb.height, open])

  if (actions.length === 0) return null
  const ctx = { node, env }

  if (!open) {
    return (
      <div className="panel color-panel color-panel--collapsed" ref={ref}>
        <button
          type="button"
          className="panel__btn color-panel__toggle"
          title={actions.map((a) => a.label).join(', ')}
          data-testid="node-panel-toggle"
          onClick={() => setOpen(true)}
        >
          {actions.map((a) => a.summary && <span key={a.id}>{a.summary(ctx)}</span>)}
        </button>
      </div>
    )
  }

  return (
    <div className="panel color-panel" ref={ref} data-testid="node-panel">
      {actions.map((a) => (
        <div key={a.id} className="node-panel__section" data-action={a.id}>
          <a.render {...ctx} slot="panel" />
        </div>
      ))}
      <button
        type="button"
        className="panel__btn color-panel__close"
        title="Свернуть"
        onClick={() => setOpen(false)}
      >
        ✕
      </button>
    </div>
  )
}
