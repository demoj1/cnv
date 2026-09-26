/**
 * Структурный интерфейс `<webview>` — ровно то, чем мы пользуемся. Тянуть в renderer
 * типы electron ради одного тега не за чем, а `any` запрещён.
 */
export interface WebviewElement extends HTMLElement {
  src: string
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getWebContentsId(): number
  focus(): void
}

export interface LoadFailure {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}

export function createWebview(url: string, partition: string): WebviewElement {
  const el = document.createElement('webview') as WebviewElement
  el.setAttribute('partition', partition)
  el.setAttribute('allowpopups', '')
  el.setAttribute('src', url)
  return el
}

/** `did-fail-load` приходит и на подресурсы; интересен только главный фрейм. */
export function isMainFrameFailure(e: Event): LoadFailure | null {
  const ev = e as Event & Partial<LoadFailure>
  if (ev.isMainFrame !== true) return null
  // ERR_ABORTED — это отмена навигации, а не ошибка страницы.
  if (ev.errorCode === -3) return null
  return {
    errorCode: ev.errorCode ?? 0,
    errorDescription: ev.errorDescription ?? '',
    validatedURL: ev.validatedURL ?? '',
    isMainFrame: true
  }
}
