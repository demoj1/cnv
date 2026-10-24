import { app, session, shell, webContents, type WebContents } from 'electron'
import { WEB_PARTITION } from '@shared/app'
import { IPC } from '@shared/ipc'
import { handleFileProtocol } from './file-protocol'
import type { Workspace } from './workspace'
import type { SettingsStore } from './settings-store'

// canvas-file — локальный HTML, брошенный на холст: тоже открываем в госте. Схема
// privileged и заперта в корне воркспейса по realpath, наружу из него не выйти.
const GUEST_SCHEMES = /^(https?|canvas-file):$/i

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

export function prepareGuestSession(workspace: Workspace): void {
  const ses = session.fromPartition(WEB_PARTITION)
  // canvas-file:// в гостевой сессии свой: без этого локальный HTML в webview не грузится.
  handleFileProtocol(workspace, ses.protocol)
  ses.setUserAgent(browserUserAgent(ses.getUserAgent()))
  ses.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission))
  )
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
}

/** Масштаб страницы, выбранный кнопками −/+ в шапке ноды, по id гостя. */
const pageZooms = new Map<number, number>()

const guestZoom = (guest: WebContents, uiScale: number): number => uiScale * (pageZooms.get(guest.id) ?? 1)

/** Гость — отдельный WebContents со своим zoom: без этого при UI-скейле он рассинхронится с рамкой ноды. */
export function applyGuestScale(scale: number): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.getType() === 'webview' && !wc.isDestroyed()) wc.setZoomFactor(guestZoom(wc, scale))
  }
}

export function setGuestPageZoom(guestId: number, zoom: number, uiScale: number): void {
  const guest = webContents.fromId(guestId)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return
  if (!Number.isFinite(zoom) || zoom <= 0) return
  pageZooms.set(guestId, zoom)
  guest.setZoomFactor(guestZoom(guest, uiScale))
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
  const applyScale = (): void => guest.setZoomFactor(guestZoom(guest, settings.settings.uiScale))
  applyScale()
  guest.once('destroyed', () => pageZooms.delete(guest.id))
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
    // Alt+цифра — смена стола, даже когда фокус внутри страницы: до холста клавиша не дойдёт.
    const digit = /^Digit(\d)$/.exec(input.code)?.[1]
    if (input.type === 'keyDown' && digit && input.alt && !input.control && !input.meta) {
      event.preventDefault()
      const n = digit === '0' ? 10 : Number(digit)
      host.send(IPC.menuCommand, input.shift ? `desktop.move${n}` : `desktop.${n}`)
    }
  })

  // Масштабом страницы распоряжаются UI-скейл и кнопки −/+ ноды: если гость всё же зазумился сам
  // (например с клавиатуры), возвращаем на место.
  guest.on('zoom-changed', applyScale)

  guest.on('will-navigate', (event, url) => {
    try {
      if (!GUEST_SCHEMES.test(new URL(url).protocol)) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
}
