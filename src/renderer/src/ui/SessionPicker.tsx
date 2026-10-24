import { useEffect, useState } from 'react'
import type { AgentSessionInfo } from '@shared/agent-plugin'

interface Props {
  /** Плагин агента и его папка: сессии ищутся в ней. */
  plugin: string
  label: string
  cwd: string | undefined
  current?: string
  onPick(sessionId: string): void
  onClose(): void
}

const ago = (ms: number): string => {
  const min = Math.round((Date.now() - ms) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/**
 * «Продолжить сессию…»: сессии агента в его папке (свежие сверху), id можно вписать руками,
 * пустая строка — новая сессия.
 */
export function SessionPicker({ plugin, label, cwd, current, onPick, onClose }: Props): React.JSX.Element {
  const [sessions, setSessions] = useState<AgentSessionInfo[] | null>(null)
  const [manual, setManual] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.agents.sessions(plugin, cwd).then((list) => alive && setSessions(list))
    return () => {
      alive = false
    }
  }, [plugin, cwd])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dialog--wide" role="dialog" data-testid="session-picker">
        <div className="dialog__title">
          Продолжить сессию — {label}
          <span className="settings__hint"> · {cwd || '~'}</span>
        </div>
        <div className="session-list">
          {sessions === null && <div className="settings__hint">ищу сессии…</div>}
          {sessions?.length === 0 && <div className="settings__hint">в этой папке сессий нет</div>}
          {sessions?.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`session-list__item${s.id === current ? ' session-list__item--current' : ''}`}
              data-session={s.id}
              onClick={() => onPick(s.id)}
            >
              <span className="session-list__title">{s.title ?? 'без названия'}</span>
              <span className="session-list__meta">
                {ago(s.updatedAt)} · {s.id.slice(0, 8)}
                {s.id === current ? ' · текущая' : ''}
              </span>
            </button>
          ))}
        </div>
        <div className="dialog__buttons">
          <input
            className="dialog__input session-list__manual"
            placeholder="или id сессии руками"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && manual.trim()) onPick(manual.trim())
            }}
          />
          <button type="button" onClick={() => onPick('')}>
            Новая сессия
          </button>
          <button type="button" onClick={onClose}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}
