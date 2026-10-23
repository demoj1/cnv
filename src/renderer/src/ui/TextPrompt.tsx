import { useState } from 'react'

interface Props {
  title: string
  initial: string
  placeholder?: string
  /** Можно ли сдать пустое значение (снять роль, например). */
  allowEmpty?: boolean
  onSubmit(value: string): void
  onCancel(): void
}

/** Однострочный ввод в диалоге: имя, роль. */
export function TextPrompt({
  title,
  initial,
  placeholder,
  allowEmpty,
  onSubmit,
  onCancel
}: Props): React.JSX.Element {
  const [value, setValue] = useState(initial)

  const submit = (): void => {
    const trimmed = value.trim()
    if (!trimmed && !allowEmpty) return onCancel()
    onSubmit(trimmed)
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" data-testid="text-prompt">
        <div className="dialog__title">{title}</div>
        <input
          autoFocus
          className="dialog__input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="dialog__buttons">
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" onClick={submit}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
