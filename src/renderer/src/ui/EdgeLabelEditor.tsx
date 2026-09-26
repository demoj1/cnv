import { useState } from 'react'

interface Props {
  initial: string
  onSubmit(label: string): void
  onCancel(): void
}

export function EdgeLabelEditor({ initial, onSubmit, onCancel }: Props): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" data-testid="edge-label">
        <div className="dialog__title">Подпись связи</div>
        <input
          autoFocus
          className="dialog__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(value.trim())
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="dialog__buttons">
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" onClick={() => onSubmit(value.trim())}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}
