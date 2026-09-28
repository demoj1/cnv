import { app, session, shell, webContents, type WebContents } from 'electron'
import { WEB_PARTITION } from '@shared/app'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from './settings-store'

const GUEST_SCHEMES = /^https?:$/i

/**
 * Разрешения, без которых ломаются обычные сайты и логины. Всё остальное (камера,
 * микрофон, геолокация, нотификации, USB и прочее) отклоняется по умолчанию — ТЗ 2.4.
 */
const ALLOWED_PERMISSIONS = new Set([
  'storage-access',
  'top-level-storage-access',
  'persistent-storage',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock'
])

/** UA без токенов Electron и приложения: иначе часть провайдеров входа считает браузер небезопасным. */
function browserUserAgent(defaultUa: string): string {
  return defaultUa
    .replace(/ Electron\/[^\s]+/, '')
    .replace(new RegExp(` ${app.getName()}\\/[^\\s]+`), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function prepareGuestSession(): void {
  const ses = session.fromPartition(WEB_PARTITION)
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()))
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  )
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
}

/** Гость — отдельный WebContents со своим zoom: без этого при UI-скейле он рассинхронится с рамкой ноды. */
export function applyGuestScale(scale: number): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview' && !wc.isDestroyed()) wc.setZoomFactor(scale)
  }
}

export function installGuestHardening(settings: SettingsStore): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webviewTag = false

      const src = String(params.src ?? '')
      if (!src) return
      let scheme: string
      try {
        scheme = new URL(src).protocol
      } catch {
        event.preventDefault()
        return
      }
      if (!GUEST_SCHEMES.test(scheme)) event.preventDefault()
    })

    contents.on('did-attach-webview', (_e, guest) => {
      attachGuest(contents, guest, settings)
    })
  })
}

function attachGuest(host: WebContents, guest: WebContents, settings: SettingsStore): void {
  const applyScale = (): void => guest.setZoomFactor(settings.settings.uiScale)
  applyScale()
  guest.on('did-finish-load', applyScale)
  void guest.setVisualZoomLevelLimits(1, 1)

  guest.setWindowOpenHandler(({ url }) => {
    if (settings.settings.web.windowOpen === 'external-browser') {
      void shell.openExternal(url)
    } else {
      host.send(IPC.guestWindowOpen, { guestId: guest.id, url })
    }
    return { action: 'deny' }
  })

  guest.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      host.send(IPC.guestEscape, guest.id)
    }
  })

  // Ctrl+колесо над страницей должно менять масштаб холста, а не страницы. Колесо у
  // `input-event` приходит без дельты и координат, поэтому точку курсора запоминаем с
  // `mouseMove` (её там отдают), а сам жест ловим штатным `zoom-changed` — он для того и
  // есть. Свой zoom гостю возвращаем на место: масштабом страницы распоряжается UI-скейл.
  let cursor = { x: 0, y: 0 }
  guest.on('input-event', (_event, input) => {
    const mouse = input as typeof input & { x?: number; y?: number }
    if (mouse.type !== 'mouseMove' || mouse.x === undefined || mouse.y === undefined) return
    cursor = { x: mouse.x, y: mouse.y }
  })
  guest.on('zoom-changed', (_event, direction) => {
    applyScale()
    host.send(IPC.guestWheelZoom, { guestId: guest.id, direction, x: cursor.x, y: cursor.y })
  })

  guest.on('will-navigate', (event, url) => {
    try {
      if (!GUEST_SCHEMES.test(new URL(url).protocol)) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
}
