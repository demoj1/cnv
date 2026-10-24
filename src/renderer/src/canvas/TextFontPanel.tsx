import { useLayoutEffect, useRef, useState } from 'react'
import { worldToScreen, type Camera } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { nodeRect, type DocNode } from '@core/document'
import { nodeRotate, rotatedAABB } from '@core/image-edit'
import {
  clampFontSize,
  FONT_PRESETS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIZE_PRESETS,
  textEdit,
  withTextEdit,
  type TextEdit
} from '@core/text-edit'
import { patchNodes } from '@core/ops'
import type { CanvasColor } from '@shared/canvas'
import { useCanvasEnv } from './env'

interface Props {
  camera: CameraController
  node: DocNode
}

/** Палитра JSON Canvas: те же 6 цветов, что в меню «Цвет». */
const COLORS: readonly { value: CanvasColor; label: string }[] = [
  { value: '1', label: 'Красный' },
  { value: '2', label: 'Оранжевый' },
  { value: '3', label: 'Жёлтый' },
  { value: '4', label: 'Зелёный' },
  { value: '5', label: 'Голубой' },
  { value: '6', label: 'Фиолетовый' }
]

/** Отступ панели под нижним краем габаритной коробки — в экранных пикселях. */
const GAP = 14

/**
 * Панель под выделенной карточкой: цвет, пресеты шрифта, быстрые размеры и слайдер для
 * точной подгонки. Висит снизу, чтобы не лезть на гизмо поворота сверху. По аналогии с
 * ImageColorPanel для картинок.
 */
export function TextFontPanel({ camera, node }: Props): React.JSX.Element {
  const { store, settings } = useCanvasEnv()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const edit: TextEdit | null = textEdit(node)
  const family = edit?.fontFamily ?? 'system'
  const size = edit?.fontSize ?? settings.nodes.defaultFontSize
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

  const write = (patch: Partial<TextEdit>): void => {
    store.mutate('шрифт карточки', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      return patchNodes(doc, new Map([[node.id, { extra: withTextEdit(n.extra, patch) }]]))
    })
  }

  const paint = (color: CanvasColor | undefined): void => {
    store.mutate('цвет', (doc) => patchNodes(doc, new Map([[node.id, { color }]])))
  }

  // Свёрнуто — одна компактная кнопка; точка на ней — текущий цвет карточки.
  if (!open) {
    return (
      <div className="color-panel color-panel--collapsed" ref={ref}>
        <button
          type="button"
          className="color-panel__toggle"
          title="Цвет и шрифт карточки"
          data-testid="text-panel-toggle"
          onClick={() => setOpen(true)}
        >
          Aa
          <span
            className={`font-panel__dot${node.color && /^[1-6]$/.test(node.color) ? ` swatch--${node.color}` : ''}`}
            style={
              node.color?.startsWith('#')
                ? ({ '--node-color': node.color } as React.CSSProperties)
                : undefined
            }
          />
        </button>
      </div>
    )
  }

  return (
    <div className="color-panel" ref={ref}>
      <div className="font-panel__group" role="group" aria-label="Цвет" data-testid="text-colors">
        <button
          type="button"
          className={`font-panel__swatch font-panel__swatch--none${node.color ? '' : ' font-panel__swatch--on'}`}
          title="Без цвета"
          onClick={() => paint(undefined)}
        />
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`font-panel__swatch swatch--${c.value}${node.color === c.value ? ' font-panel__swatch--on' : ''}`}
            title={c.label}
            data-color={c.value}
            onClick={() => paint(c.value)}
          />
        ))}
      </div>
      <div className="font-panel__group" role="group" aria-label="Шрифт">
        {FONT_PRESETS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`font-panel__btn${family === f.key ? ' font-panel__btn--on' : ''}`}
            title={f.label}
            style={{ fontFamily: f.stack }}
            onClick={() => write({ fontFamily: f.key })}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="font-panel__group" role="group" aria-label="Размер">
        {SIZE_PRESETS.map((s) => (
          <button
            key={s.label}
            type="button"
            className={`font-panel__btn${size === s.value ? ' font-panel__btn--on' : ''}`}
            title={`${s.value}px`}
            onClick={() => write({ fontSize: s.value })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <label className="color-panel__tol" title={`Размер: ${size}px`}>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={size}
          onChange={(e) => write({ fontSize: clampFontSize(Number(e.target.value)) })}
        />
      </label>
      <button type="button" className="color-panel__close" title="Свернуть" onClick={() => setOpen(false)}>
        ✕
      </button>
    </div>
  )
}
