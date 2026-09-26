import { app, session, shell, type WebContents } from 'electron'
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

  guest.on('will-navigate', (event, url) => {
    try {
      if (!GUEST_SCHEMES.test(new URL(url).protocol)) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
}
