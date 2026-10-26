import { useEffect, useRef, useState } from 'react'
import type { DocNode } from '@core/document'
import { imageEdit, withImageEdit, type ColorKey } from '@core/image-edit'
import { isMarkdownFile, isTextFile, nodeKind, TEXT_FILE_SIZE } from '@core/node-kind'
import { isAgent, terminalSpec, withTerminalSpec } from '@core/terminal'
import { fileSource, fileView, patchNodes, withFileView, withoutFileSource } from '@core/ops'
import { refreshLinkedFiles } from '@renderer/workspace/useLinkedFiles'
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
import type { CanvasColor } from '@shared/canvas'
import { registerNodeAction, type NodeActionContext, type NodeActionSlot } from './actions'

/** Палитра JSON Canvas: те же 6 цветов, что в меню «Цвет». */
const COLORS: readonly { value: CanvasColor; label: string }[] = [
  { value: '1', label: 'Красный' },
  { value: '2', label: 'Оранжевый' },
  { value: '3', label: 'Жёлтый' },
  { value: '4', label: 'Зелёный' },
  { value: '5', label: 'Голубой' },
  { value: '6', label: 'Фиолетовый' }
]

/** Точка текущего цвета ноды: палитра — классом, произвольный hex — переменной. */
export function ColorDot({ color }: { color: string | undefined }): React.JSX.Element {
  return (
    <span
      className={`font-panel__dot${color && /^[1-6]$/.test(color) ? ` swatch--${color}` : ''}`}
      style={color?.startsWith('#') ? ({ '--node-color': color } as React.CSSProperties) : undefined}
    />
  )
}

function Swatches({ node, env }: NodeActionContext): React.JSX.Element {
  const paint = (color: CanvasColor | undefined): void => {
    env.store.mutate('цвет', (doc) => patchNodes(doc, new Map([[node.id, { color }]])))
  }
  return (
    <div className="font-panel__group" role="group" aria-label="Цвет" data-testid="node-colors">
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
  )
}

/** В шапке места мало: точка цвета, по клику — палитра под ней. */
function HeaderColor(ctx: NodeActionContext): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  return (
    <span className="node-header-color" ref={ref}>
      <button
        type="button"
        className="node-header-action"
        title="Цвет"
        data-testid="header-color"
        onClick={() => setOpen((v) => !v)}
      >
        <ColorDot color={ctx.node.color ?? undefined} />
      </button>
      {open && (
        <span className="node-header-popover">
          <Swatches {...ctx} />
        </span>
      )}
    </span>
  )
}

registerNodeAction({
  id: 'color',
  label: 'Цвет',
  slots: ['header', 'panel'],
  when: () => true,
  order: 10,
  summary: ({ node }) => <ColorDot color={node.color ?? undefined} />,
  render: ({ slot, ...ctx }: NodeActionContext & { slot: NodeActionSlot }) =>
    slot === 'header' ? <HeaderColor {...ctx} /> : <Swatches {...ctx} />
})

function Font({ node, env }: NodeActionContext): React.JSX.Element {
  const edit: TextEdit | null = textEdit(node)
  const family = edit?.fontFamily ?? 'system'
  const size = edit?.fontSize ?? env.settings.nodes.defaultFontSize
  const write = (patch: Partial<TextEdit>): void => {
    env.store.mutate('шрифт карточки', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      return patchNodes(doc, new Map([[node.id, { extra: withTextEdit(n.extra, patch) }]]))
    })
  }
  return (
    <>
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
    </>
  )
}

registerNodeAction({
  id: 'font',
  label: 'Шрифт',
  slots: ['panel'],
  when: (node) =>
    nodeKind(node) === 'text' ||
    nodeKind(node) === 'board' ||
    (node.type === 'file' && isMarkdownFile(node.file) && fileView(node) === 'content'),
  order: 20,
  summary: () => 'Aa',
  render: Font
})

const colorKeys = (node: DocNode): ColorKey[] => imageEdit(node)?.colorKeys ?? []

/** Маска по цвету: пипетка добавляет цвет, чипы его показывают и удаляют, слайдер — допуск у всех. */
function ColorMask({ node, env }: NodeActionContext): React.JSX.Element {
  const keys = colorKeys(node)
  const writeKeys = (next: ColorKey[]): void => {
    env.store.mutate('маска по цвету', (doc) => {
      const n = doc.nodes.find((x) => x.id === node.id)
      if (!n) return doc
      return patchNodes(doc, new Map([[node.id, { extra: withImageEdit(n.extra, { colorKeys: next }) }]]))
    })
  }
  const tolerance = keys[0]?.tolerance ?? 0.12
  return (
    <>
      <button
        type="button"
        className="color-panel__pick"
        title="Вырезать цвет пипеткой"
        onClick={() => env.startEyedropper(node.id)}
      >
        💧 Вырезать цвет
      </button>
      {keys.map((k, i) => (
        <button
          key={`${k.color}-${i}`}
          type="button"
          className="color-panel__chip"
          title={`${k.color} — убрать`}
          onClick={() => writeKeys(keys.filter((_, idx) => idx !== i))}
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
            onChange={(e) => writeKeys(keys.map((k) => ({ ...k, tolerance: Number(e.target.value) })))}
          />
        </label>
      )}
    </>
  )
}

registerNodeAction({
  id: 'color-mask',
  label: 'Маска по цвету',
  slots: ['panel'],
  when: (node) => nodeKind(node) === 'image',
  order: 30,
  summary: ({ node }) => `🎨${colorKeys(node).length > 0 ? ` ${colorKeys(node).length}` : ''}`,
  render: ColorMask
})

registerNodeAction({
  id: 'agent-pause',
  label: 'Пауза агента',
  slots: ['header', 'panel'],
  when: isAgent,
  order: 4,
  summary: ({ node }) => (terminalSpec(node)?.paused ? '▶' : '⏸'),
  render: ({ node, env }) => {
    const paused = terminalSpec(node)?.paused === true
    return (
      <button
        type="button"
        className="node-header-action"
        data-testid="agent-pause"
        title={paused ? 'Продолжить агента в той же сессии' : 'Пауза: остановить агента, письма будут ждать'}
        aria-label={paused ? 'Продолжить агента' : 'Пауза агента'}
        onClick={() =>
          env.store.mutate(paused ? 'продолжить агента' : 'пауза агента', (doc) => {
            const live = doc.nodes.find((n) => n.id === node.id)
            return live
              ? patchNodes(
                  doc,
                  new Map([
                    [
                      node.id,
                      {
                        extra: withTerminalSpec(live.extra, { paused: !paused })
                      }
                    ]
                  ])
                )
              : doc
          })
        }
      >
        {paused ? '▶' : '⏸'}
      </button>
    )
  }
})

registerNodeAction({
  id: 'agent-session',
  label: 'Продолжить другую сессию',
  slots: ['header'],
  when: isAgent,
  order: 5,
  render: ({ node, env }) => (
    <button
      type="button"
      className="node-header-action"
      title="Продолжить другую сессию…"
      data-testid="header-session"
      onClick={() => env.pickSession(node.id)}
    >
      ⟲
    </button>
  )
})

/** Файл-копия, которая следует за оригиналом: обновить сейчас или отвязать. */
function FileLink({ node, env }: NodeActionContext): React.JSX.Element {
  const source = fileSource(node) ?? ''
  const [note, setNote] = useState<string | null>(null)
  return (
    <>
      <span className="node-panel__note" title={source}>
        🔗 {source.split(/[\\/]/).pop()}
      </span>
      <button
        type="button"
        className="font-panel__btn"
        title={`Обновить копию из ${source}`}
        data-testid="file-refresh"
        onClick={() =>
          void refreshLinkedFiles(env.store, [node.id]).then(
            (done) => setNote(done.length > 0 ? 'обновлено' : 'уже свежая'),
            () => setNote('оригинала нет')
          )
        }
      >
        ⟳
      </button>
      <button
        type="button"
        className="font-panel__btn"
        title="Отвязать: копия останется как есть и больше не будет следовать за оригиналом"
        onClick={() =>
          env.store.mutate('отвязать файл', (doc) =>
            patchNodes(doc, new Map([[node.id, { extra: withoutFileSource(node).extra }]]))
          )
        }
      >
        отвязать
      </button>
      {note && <span className="node-panel__note">{note}</span>}
    </>
  )
}

registerNodeAction({
  id: 'file-link',
  label: 'Копия следует за оригиналом',
  slots: ['panel'],
  when: (node) => fileSource(node) !== undefined,
  order: 40,
  summary: () => '🔗',
  render: FileLink
})

/** Плашка с иконкой — компактная, содержимое — читаемая карточка. */
const CHIP_SIZE = { width: 260, height: 64 }

function TextFileViewToggle({ node, env }: NodeActionContext): React.JSX.Element {
  const view = fileView(node)
  const next = view === 'content' ? 'chip' : 'content'
  return (
    <button
      type="button"
      className="font-panel__btn"
      data-testid="file-view-toggle"
      title={view === 'content' ? 'Свернуть в плашку' : 'Показать содержимое файла'}
      onClick={() =>
        env.store.mutate(next === 'chip' ? 'файл плашкой' : 'файл содержимым', (doc) =>
          patchNodes(
            doc,
            new Map([
              [
                node.id,
                {
                  extra: withFileView(node.extra, next),
                  ...(next === 'chip'
                    ? CHIP_SIZE
                    : {
                        width: Math.max(node.width, TEXT_FILE_SIZE.width),
                        height: Math.max(node.height, TEXT_FILE_SIZE.height)
                      })
                }
              ]
            ])
          )
        )
      }
    >
      {view === 'content' ? '▭ плашкой' : '▤ содержимое'}
    </button>
  )
}

registerNodeAction({
  id: 'file-view',
  label: 'Вид файла',
  slots: ['panel'],
  when: (node) => node.type === 'file' && isTextFile(node.file),
  order: 35,
  summary: () => '▤',
  render: TextFileViewToggle
})
