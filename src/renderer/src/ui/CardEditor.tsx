import { useState } from 'react'
import type { CanvasColor } from '@shared/canvas'
import { MarkdownEditor } from '@renderer/nodes/MarkdownEditor'

const COLORS: CanvasColor[] = ['1', '2', '3', '4', '5', '6']

interface Props {
  title: string
  initial: string
  color?: CanvasColor
  onSubmit(text: string, color: CanvasColor | null): void
  onDelete?(): void
  onCancel(): void
}

/** Редактор карточки доски поверх холста: markdown и цвет. Ctrl+Enter — сохранить, Esc — отмена. */
export function CardEditor({
  title,
  initial,
  color,
  onSubmit,
  onDelete,
  onCancel
}: Props): React.JSX.Element {
  const [text, setText] = useState(initial)
  const [picked, setPicked] = useState<CanvasColor | null>(color ?? null)
  const submit = (): void => (text.trim() ? onSubmit(text, picked) : onCancel())

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog card-editor"
        role="dialog"
        data-testid="card-editor"
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit()
          if (e.key === 'Escape') onCancel()
        }}
      >
        <div className="dialog__title">{title}</div>
        <div className="card-editor__text" data-owns-input>
          <MarkdownEditor value={initial} onChange={setText} />
        </div>
        <div className="card-editor__colors">
          <button
            type="button"
            className={`card-editor__swatch card-editor__swatch--none${picked === null ? ' card-editor__swatch--on' : ''}`}
            title="Без цвета"
            onClick={() => setPicked(null)}
          />
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`card-editor__swatch swatch--${c}${picked === c ? ' card-editor__swatch--on' : ''}`}
              onClick={() => setPicked(c)}
            />
          ))}
        </div>
        <div className="dialog__buttons">
          {onDelete && (
            <button
              type="button"
              className="card-editor__delete"
              data-testid="card-delete"
              onClick={onDelete}
            >
              Удалить
            </button>
          )}
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" data-testid="card-save" onClick={submit}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
