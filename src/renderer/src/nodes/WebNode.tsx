import { useEffect, useRef, useState } from 'react'
import type { LinkNode } from '@shared/canvas'
import { WEB_PARTITION } from '@shared/app'
import type { DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import { snapshotKeyFor } from '@core/web-lifecycle'
import { useCanvasEnv } from '@renderer/canvas/env'
import { useWebRuntime } from '@renderer/web/context'
import {
  createWebview,
  isMainFrameFailure,
  type LoadFailure,
  type WebviewElement
} from '@renderer/web/webview-element'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & LinkNode>

interface GuestState {
  title: string
  favicon: string | null
  loading: boolean
  failure: LoadFailure | null
  canGoBack: boolean
  canGoForward: boolean
}

const INITIAL: GuestState = {
  title: '',
  favicon: null,
  loading: true,
  failure: null,
  canGoBack: false,
  canGoForward: false
}

export function WebNodeView({ node, selected, active }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const runtime = useWebRuntime()
  const live = runtime.isLive(node.id)
  const snapshot = runtime.snapshotFor(node.id)

  const hostRef = useRef<HTMLDivElement>(null)
  const guestRef = useRef<WebviewElement | null>(null)
  const [guest, setGuest] = useState<GuestState>(INITIAL)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !live) return

    const el = createWebview(node.url, WEB_PARTITION)
    el.className = 'node-web__frame'
    guestRef.current = el
    runtime.registerGuest(node.id, el)
    setGuest({ ...INITIAL })

    const sync = (): void =>
      setGuest((s) => ({
        ...s,
        title: el.getTitle(),
        canGoBack: el.canGoBack(),
        canGoForward: el.canGoForward()
      }))

    const onDomReady = (): void => {
      runtime.noteGuestId(node.id, el.getWebContentsId())
      sync()
    }
    const onStart = (): void => setGuest((s) => ({ ...s, loading: true, failure: null }))
    const onStop = (): void => {
      setGuest((s) => ({ ...s, loading: false }))
      sync()
    }
    const onTitle = (e: Event): void => {
      const title = (e as Event & { title?: string }).title ?? ''
      setGuest((s) => ({ ...s, title }))
    }
    const onFavicon = (e: Event): void => {
      const icons = (e as Event & { favicons?: string[] }).favicons ?? []
      setGuest((s) => ({ ...s, favicon: icons[0] ?? null }))
    }
    const onFail = (e: Event): void => {
      const failure = isMainFrameFailure(e)
      if (failure) setGuest((s) => ({ ...s, loading: false, failure }))
    }
    // Навигация правит url в документе, но мимо истории холста (ТЗ 7.6).
    const onNavigate = (e: Event): void => {
      const url = (e as Event & { url?: string }).url
      if (!url || url === node.url) return
      store.mutateSilent((doc) => patchNodes(doc, new Map([[node.id, { url }]])))
      sync()
    }

    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('page-favicon-updated', onFavicon)
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)

    host.appendChild(el)

    return () => {
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('page-favicon-updated', onFavicon)
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', onNavigate)
      runtime.registerGuest(node.id, null)
      guestRef.current = null
      el.remove()
    }
    // node.url меняется и от навигации самого гостя — перезагружать его на это не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, node.id, reloadToken, runtime, store])

  useEffect(() => {
    if (active) guestRef.current?.focus()
  }, [active])

  const commitUrl = (): void => {
    const raw = (urlDraft ?? '').trim()
    setUrlDraft(null)
    if (!raw) return
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    if (url === node.url) return
    store.mutate('адрес веб-ноды', (doc) => patchNodes(doc, new Map([[node.id, { url }]])))
    setReloadToken((v) => v + 1)
  }

  const takeSnapshot = async (): Promise<void> => {
    const el = guestRef.current
    if (!el) return
    const dataUrl = await window.api.snapshots.capture(el.getWebContentsId())
    if (dataUrl) await window.api.snapshots.save(snapshotKeyFor(node.id, node.url), dataUrl)
  }

  let host = node.url
  try {
    host = new URL(node.url).host
  } catch {
    /* оставляем адрес как есть */
  }

  return (
    <div className={active ? 'node-web node-web--active' : 'node-web'}>
      {(selected || active) && (
        <div className="node-web__bar" data-testid="web-bar">
          {guest.favicon ? (
            <img className="node-web__favicon" src={guest.favicon} alt="" />
          ) : (
            <span className="node-web__favicon node-web__favicon--empty" />
          )}
          <button
            type="button"
            title="Назад"
            disabled={!guest.canGoBack}
            onClick={() => guestRef.current?.goBack()}
          >
            ‹
          </button>
          <button
            type="button"
            title="Вперёд"
            disabled={!guest.canGoForward}
            onClick={() => guestRef.current?.goForward()}
          >
            ›
          </button>
          <button type="button" title="Перезагрузить" onClick={() => setReloadToken((v) => v + 1)}>
            ⟳
          </button>
          <input
            className="node-web__url"
            value={urlDraft ?? node.url}
            title={guest.title || node.url}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setUrlDraft(null)
            }}
          />
          <button
            type="button"
            title="Открыть в браузере"
            onClick={() => void window.api.shell.openExternal(node.url)}
          >
            ↗
          </button>
          <button type="button" title="Сделать снимок" disabled={!live} onClick={() => void takeSnapshot()}>
            ◉
          </button>
          <button
            type="button"
            title={active ? 'Выйти из страницы' : 'Взаимодействовать'}
            onClick={() => store.setActiveNode(active ? null : node.id)}
          >
            {active ? '✕' : '⊙'}
          </button>
        </div>
      )}

      <div className="node-web__body" data-live={live ? 'true' : 'false'}>
        {/* Отдельный контейнер: <webview> вставляется руками, React в него не лезет. */}
        <div className="node-web__mount" ref={hostRef} />
        {!live &&
          (snapshot ? (
            <img className="node-web__snapshot" src={snapshot} alt={host} draggable={false} />
          ) : (
            <div className="node-web-placeholder">
              <div className="node-web-placeholder__host">{host}</div>
            </div>
          ))}
        {live && guest.loading && !guest.failure && <div className="node-web__loading" />}
        {guest.failure && (
          <div className="node-error node-web__failure">
            <div className="node-error__title">Страница не загрузилась</div>
            <div className="node-error__detail">
              {guest.failure.errorDescription} ({guest.failure.errorCode})
            </div>
            <button type="button" onClick={() => setReloadToken((v) => v + 1)}>
              Повторить
            </button>
          </div>
        )}
        {!active && <div className="node-web__shield" data-testid="web-shield" />}
      </div>
    </div>
  )
}
