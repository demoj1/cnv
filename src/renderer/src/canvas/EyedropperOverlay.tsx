import { useEffect, useRef, useState } from 'react'
import { worldRectToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { imageEdit, uncroppedRect, withImageEdit } from '@core/image-edit'
import { rgbToHex } from '@core/color-mask'
import { patchNodes } from '@core/ops'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
  onClose(): void
}

const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 }
/** Допуск у свежесэмплированного цвета — мягкий старт, дальше крутят слайдером. */
const DEFAULT_TOLERANCE = 0.12

/**
 * Пипетка: показываем исходник целиком (неповёрнутым), клик берёт цвет пикселя исходника и
 * добавляет его в ключи маски. Esc отменяет. Читаем именно исходник, а не уже обработанную
 * картинку, — иначе пипетка ловила бы прозрачность.
 */
export function EyedropperOverlay({ camera, node, onClose }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const [cam] = useState<Camera>(() => camera.value)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const box = worldRectToScreen(cam, nodeRect(node))
  const crop = imageEdit(node)?.crop ?? FULL_CROP
  const full = uncroppedRect(box, crop)
  const file = node.type === 'file' ? node.file : ''
  const src = window.api.files.url(file)

  useEffect(() => {
    let alive = true
    void fetch(src)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bm) => {
        if (!alive) {
          bm.close()
          return
        }
        bitmapRef.current = bm
        const c = document.createElement('canvas')
        c.width = bm.width
        c.height = bm.height
        c.getContext('2d')?.drawImage(bm, 0, 0)
        canvasRef.current = c
      })
    return () => {
      alive = false
      bitmapRef.current?.close()
    }
  }, [src])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onClick = (e: React.MouseEvent): void => {
    const canvas = canvasRef.current
    const root = rootRef.current
    if (!canvas || !root) return
    const rootBox = root.getBoundingClientRect()
    const lx = (e.clientX - rootBox.left - full.x) / full.width
    const ly = (e.clientY - rootBox.top - full.y) / full.height
    if (lx < 0 || lx > 1 || ly < 0 || ly > 1) return
    const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(lx * canvas.width)))
    const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(ly * canvas.height)))
    const [r, g, b] = canvas.getContext('2d')?.getImageData(px, py, 1, 1).data ?? [0, 0, 0]
    const color = rgbToHex([r ?? 0, g ?? 0, b ?? 0])
    store.mutate('цвет маски', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      const keys = imageEdit(n)?.colorKeys ?? []
      const next = [...keys, { color, tolerance: DEFAULT_TOLERANCE }]
      return patchNodes(doc, new Map([[node.id, { extra: withImageEdit(n.extra, { colorKeys: next }) }]]))
    })
    onClose()
  }

  return (
    <div className="eyedropper" ref={rootRef} onClick={onClick}>
      <img
        className="eyedropper__img"
        src={src}
        alt=""
        draggable={false}
        style={{ left: full.x, top: full.y, width: full.width, height: full.height }}
      />
      <div className="eyedropper__hint">Клик по картинке — вырезать этот цвет. Esc — отмена.</div>
    </div>
  )
}
