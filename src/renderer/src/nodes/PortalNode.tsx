import { useState } from 'react'
import type { DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import {
  formatFingerprint,
  normalizePortalKey,
  portalMembers,
  portalSpec,
  withPortalSpec
} from '@core/portal'
import type { PortalStatus } from '@shared/portal'
import { useCanvasEnv } from '@renderer/canvas/env'
import { portalHub, usePortalView } from '@renderer/portal/usePortals'
import type { NodeViewProps } from './registry'

const STATUS: Record<PortalStatus, string> = {
  idle: 'нет ключа',
  searching: 'ищу пару…',
  confirm: 'пришли с той стороны',
  connected: 'на связи',
  rejected: 'не пустили',
  error: 'ошибка'
}

/** Ключ на экране — только края: подсмотреть через плечо целиком нельзя. */
const masked = (key: string): string =>
  key
    .split('-')
    .map((part, i, all) => (i === 0 || i === all.length - 1 ? part : '••••'))
    .join('-')

/**
 * Портал — дверь к агентам другого cnv. На обеих сторонах открыт портал с одним ключом,
 * и агенты, подключённые к своему порталу стрелками, пишут друг другу. Остальной холст
 * через портал не видно.
 */
export function PortalNodeView({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store } = useCanvasEnv()
  const spec = portalSpec(node)
  const view = usePortalView(node.id)
  const [shown, setShown] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  if (!spec) return <div className="node-portal" />

  const status: PortalStatus = view?.status ?? (spec.key ? 'searching' : 'idle')
  const members = portalMembers(store.doc, node.id)
  const label = spec.label ?? 'Портал'

  const patch = (next: Parameters<typeof withPortalSpec>[1], what: string): void =>
    store.mutate(what, (doc) => {
      const live = doc.nodes.find((n) => n.id === node.id)
      if (!live) return doc
      return patchNodes(doc, new Map([[node.id, { extra: withPortalSpec(live.extra, next) }]]))
    })

  const trust = (): void => {
    const peer = view?.peer
    if (!peer) return
    patch(
      {
        trusted: [
          ...spec.trusted.filter((t) => t.fingerprint !== peer.fingerprint),
          { ...peer, at: Date.now() }
        ]
      },
      'пустить в портал'
    )
  }

  const saveKey = (): void => {
    const key = normalizePortalKey(editing ?? '')
    setEditing(null)
    if (key && key !== spec.key) patch({ key, trusted: [] }, 'ключ портала')
  }

  return (
    <div className={`node-portal node-portal--${status}`} data-testid="portal" data-status={status}>
      <div className="node-portal__edge" aria-hidden />
      <div className="node-portal__title">{label}</div>
      <div className="node-portal__status" data-testid="portal-status">
        {STATUS[status]}
        {status === 'connected' && view?.rttMs !== undefined ? ` · ${view.rttMs} мс` : ''}
        {status === 'error' && view?.error ? `: ${view.error}` : ''}
      </div>

      {view?.peer && status !== 'searching' && (
        <div className="node-portal__peer" title={view.peer.fingerprint}>
          <span className="node-portal__peer-name">{view.peer.name}</span>
          <span className="node-portal__fp">{formatFingerprint(view.peer.fingerprint)}</span>
        </div>
      )}

      {status === 'confirm' && (
        <div className="node-portal__confirm">
          <span>Пустить этот cnv? Сверь отпечаток с той стороной — дальше он будет входить сам.</span>
          <div className="node-portal__buttons">
            <button type="button" className="node-portal__primary" data-testid="portal-trust" onClick={trust}>
              Пустить
            </button>
            <button type="button" data-testid="portal-reject" onClick={() => portalHub().reject(node.id)}>
              Не пускать
            </button>
          </div>
        </div>
      )}

      {(status === 'rejected' || status === 'error') && (
        <div className="node-portal__buttons">
          <button type="button" data-testid="portal-retry" onClick={() => portalHub().retry(node.id)}>
            Искать снова
          </button>
        </div>
      )}

      {status === 'connected' && (
        <div className="node-portal__side">
          <div className="node-portal__caption">там</div>
          {view?.remote.length ? (
            view.remote.map((m) => (
              <span key={m.id} className="node-portal__chip" title={m.role ?? ''} data-testid="portal-remote">
                {m.kind === 'agent' ? '✦ ' : ''}
                {m.name}
                {m.role ? <span className="node-portal__role"> · {m.role}</span> : null}
              </span>
            ))
          ) : (
            <span className="node-portal__empty">никого не подключили</span>
          )}
        </div>
      )}

      <div className="node-portal__side">
        <div className="node-portal__caption">здесь</div>
        {members.length ? (
          members.map((m) => (
            <span key={m.id} className="node-portal__chip node-portal__chip--here">
              {m.kind === 'agent' ? '✦ ' : ''}
              {m.name}
            </span>
          ))
        ) : (
          <span className="node-portal__empty">протяни стрелку от агента к порталу</span>
        )}
      </div>

      <div className="node-portal__key">
        {editing !== null ? (
          <>
            <input
              className="node-portal__key-input"
              value={editing}
              placeholder="ключ с той стороны"
              autoFocus
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') saveKey()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
            <button type="button" onClick={saveKey} title="Сохранить ключ">
              ✓
            </button>
          </>
        ) : (
          <>
            <code className="node-portal__key-text" data-testid="portal-key">
              {shown ? spec.key : masked(spec.key)}
            </code>
            <button
              type="button"
              title={shown ? 'Скрыть ключ' : 'Показать ключ'}
              onClick={() => setShown((v) => !v)}
            >
              {shown ? '◡' : '◉'}
            </button>
            <button
              type="button"
              title="Скопировать ключ — передай его той стороне"
              onClick={() => {
                void navigator.clipboard.writeText(spec.key).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                })
              }}
            >
              {copied ? '✓' : '⧉'}
            </button>
            <button
              type="button"
              title="Вставить ключ с той стороны"
              data-testid="portal-set-key"
              onClick={() => setEditing('')}
            >
              ✎
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function PortalNodeLowDetail({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const view = usePortalView(node.id)
  return (
    <div className={`node-portal node-portal--lod node-portal--${view?.status ?? 'searching'}`}>
      <div className="node-portal__edge" aria-hidden />
    </div>
  )
}
