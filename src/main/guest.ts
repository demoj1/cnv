import { app, session, shell, type WebContents } from 'electron'
import { WEB_PARTITION } from '@shared/app'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from './settings-store'

const GUEST_SCHEMES = /^https?:$/i

export function prepareGuestSession(): void {
  const ses = session.fromPartition(WEB_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
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
