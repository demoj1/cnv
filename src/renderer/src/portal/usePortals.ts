import { useEffect, useSyncExternalStore } from 'react'
import type { DocStore } from '@core/doc-store'
import type { PortalView } from '@shared/portal'
import type { Settings } from '@shared/settings'
import { PortalHub } from './hub'

/**
 * Один хаб порталов на окно: соединения живут, пока портал есть в документе, — даже если
 * сама нода за краем экрана и не смонтирована.
 */
let hub: PortalHub | null = null
/** Что хабу нужно от окна: ретрансляторы из настроек и огонёк при доставке. */
const config: { relays: string[]; delivered: ((portalId: string, toNodeId: string) => void) | null } = {
  relays: [],
  delivered: null
}

export function portalHub(): PortalHub {
  hub ??= new PortalHub({
    identity: () => window.api.portal.identity(),
    sign: (data) => window.api.portal.sign(data),
    verify: (publicKey, fingerprint, data, signature) =>
      window.api.portal.verify(publicKey, fingerprint, data, signature),
    deliver: (portalId, portalLabel, peerName, message) =>
      window.api.portal.deliver({ portalId, portalLabel, peerName, message }),
    onDelivered: (portalId, toNodeId) => config.delivered?.(portalId, toNodeId),
    relays: () => config.relays
  })
  // Для e2e и отладки: состояние порталов из консоли.
  Object.assign(window, { __cnvPortals: hub })
  return hub
}

/** Держать хаб в согласии с документом и настройками. */
export function usePortalSync(
  store: DocStore,
  settings: Settings,
  onDelivered: (portalId: string, toNodeId: string) => void
): void {
  useEffect(() => {
    config.relays = settings.portal.relays.filter((r) => r.trim())
    config.delivered = onDelivered
    portalHub().relaysChanged()
  })
  useEffect(() => {
    const h = portalHub()
    h.sync(store.doc)
    let last = store.doc
    const off = store.subscribe((state) => {
      if (state.doc === last) return
      last = state.doc
      h.sync(state.doc)
    })
    return () => {
      off()
    }
  }, [store])
  useEffect(() => () => portalHub().closeAll(), [])
}

/** Состояние одного портала для его ноды. */
export function usePortalView(id: string): PortalView | undefined {
  return useSyncExternalStore(
    (onChange) => portalHub().subscribe(onChange),
    () => portalHub().view(id)
  )
}
