import { useState } from 'react'

interface Props {
  onSubmit(url: string): void
  onCancel(): void
}

export function UrlPrompt({ onSubmit, onCancel }: Props): React.JSX.Element {
  const [value, setValue] = useState('')

  const submit = (): void => {
    const raw = value.trim()
    if (!raw) return onCancel()
    onSubmit(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  }

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" data-testid="url-prompt">
        <div className="dialog__title">Адрес страницы</div>
        <input
          autoFocus
          className="dialog__input"
          value={value}
          placeholder="example.com"
          onChange={(e) => setValue(e.target.value)}
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
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}
