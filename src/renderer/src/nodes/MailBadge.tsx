import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MailItem, MailStats } from '@shared/api'
import { HeaderButton } from './HeaderButton'

/** Почта агента из main: пересчитывается, когда письмо пришло, ушло или доставлено. */
export function useMailStats(nodeId: string, enabled: boolean): MailStats | null {
  const [stats, setStats] = useState<MailStats | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = (): void => {
      void window.api.mail.stats(nodeId).then((s) => alive && setStats(s))
    }
    load()
    const off = window.api.mail.onChange(load)
    return () => {
      alive = false
      off()
    }
  }, [nodeId, enabled])
  return enabled ? stats : null
}

function Count({ queued, total, testId }: { queued: number; total: number; testId: string }): React.JSX.Element {
  return (
    <span className="mail-badge__count" data-testid={testId}>
      <span className={queued > 0 ? 'mail-badge__queued mail-badge__queued--hot' : 'mail-badge__queued'}>
        {queued}
      </span>
      <span className="mail-badge__total">({total})</span>
    </span>
  )
}

/** ✉ ↓в очереди (всего) ↑в очереди (всего) — в шапке агента; клик — последние письма. */
export function MailBadge({
  nodeId,
  stats,
  nameOf
}: {
  nodeId: string
  stats: MailStats
  nameOf(id: string): string | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <HeaderButton
        className="node-header-action mail-badge"
        testId="agent-mail"
        title={`Почта агента. Входящие: ${stats.inQueued} в очереди, всего ${stats.inTotal}. Исходящие: ${stats.outQueued} в очереди у адресатов, всего ${stats.outTotal}. Клик — письма`}
        onClick={() => setOpen(true)}
      >
        ✉ ↓<Count queued={stats.inQueued} total={stats.inTotal} testId="agent-mail-in" /> ↑
        <Count queued={stats.outQueued} total={stats.outTotal} testId="agent-mail-out" />
      </HeaderButton>
      {open && <MailDialog nodeId={nodeId} nameOf={nameOf} onClose={() => setOpen(false)} />}
    </>
  )
}

const time = (at: number): string => {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function MailDialog({
  nodeId,
  nameOf,
  onClose
}: {
  nodeId: string
  nameOf(id: string): string | undefined
  onClose(): void
}): React.JSX.Element {
  const [items, setItems] = useState<MailItem[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.api.mail.list(nodeId).then((list) => alive && setItems(list))
    }
    load()
    const off = window.api.mail.onChange(load)
    return () => {
      alive = false
      off()
    }
  }, [nodeId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Портал в body: внутри ноды холст масштабирован, а диалогу нужен экран.
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dialog--wide" role="dialog" data-testid="mail-dialog">
        <div className="dialog__title">
          Почта — {nameOf(nodeId) ?? 'агент'}
          <span className="settings__hint"> · последние {items?.length ?? 0}, новые снизу</span>
        </div>
        <div className="mail-list">
          {items === null && <div className="settings__hint">читаю почту…</div>}
          {items?.length === 0 && <div className="settings__hint">писем пока не было</div>}
          {items?.map((m) => (
            <details key={m.id} className={`mail-list__item mail-list__item--${m.dir}`} data-mail={m.id}>
              <summary>
                <span className="mail-list__dir">{m.dir === 'in' ? '↓' : '↑'}</span>
                <span className="mail-list__peer">
                  {m.dir === 'in' ? 'от ' : 'кому '}
                  {(m.peer && nameOf(m.peer)) ?? m.peerName ?? m.peer ?? 'cnv'}
                </span>
                <span className="mail-list__time">{time(m.at)}</span>
                {m.queued && <span className="mail-list__queued">в очереди</span>}
                <span className="mail-list__preview">{m.text.split('\n', 1)[0]}</span>
              </summary>
              <pre className="mail-list__text">{m.text}</pre>
            </details>
          ))}
        </div>
        <div className="dialog__buttons">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
