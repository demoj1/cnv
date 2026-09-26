import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import { nodeRect } from '@core/document'
import { rectsIntersect } from '@core/geometry'
import { nodeKind } from '@core/node-kind'
import { chooseLiveNodes, snapshotKeyFor, type WebNodeRuntime } from '@core/web-lifecycle'
import type { Settings } from '@shared/settings'
import type { WebRuntime } from './context'
import type { WebviewElement } from './webview-element'

const TICK_MS = 1000
/** Оживляем по одной, чтобы десяток нод не поднимал десяток гостей одновременно. */
const PROMOTE_STEP_MS = 250
/**
 * Снимок перед выгрузкой — вещь приятная, но не обязательная, а `capturePage` у гостя,
 * который сейчас за краем окна, кадра может и не дождаться. Решение выгрузить важнее
 * картинки: ждём ограниченно и идём дальше.
 */
const CAPTURE_TIMEOUT_MS = 1500
/**
 * Поэтому снимаем заранее — пока нода на экране и кадр у неё точно есть. К моменту
 * выгрузки картинка уже лежит готовая, и она же показывается после перезапуска, пока
 * до ноды не долистали.
 */
const SNAPSHOT_REFRESH_MS = 15000

interface Slot {
  lastVisibleAt: number
  lastCaptureAt: number
  capturing: boolean
  el: WebviewElement | null
  webContentsId: number | null
}

export function useWebLifecycle(
  store: DocStore,
  camera: CameraController,
  settings: Settings
): { runtime: WebRuntime; liveIds: ReadonlySet<string> } {
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(new Set())
  const [, forceRender] = useState(0)
  const slots = useRef(new Map<string, Slot>())
  const snapshots = useRef(new Map<string, string>())
  const liveRef = useRef<ReadonlySet<string>>(liveIds)

  // Держим ссылку синхронно: следующий проход evaluate может случиться раньше эффектов.
  const applyLive = useCallback((next: ReadonlySet<string>): void => {
    liveRef.current = next
    setLiveIds(next)
  }, [])

  const slotFor = useCallback((id: string): Slot => {
    const existing = slots.current.get(id)
    if (existing) return existing
    const fresh: Slot = {
      lastVisibleAt: 0,
      lastCaptureAt: 0,
      capturing: false,
      el: null,
      webContentsId: null
    }
    slots.current.set(id, fresh)
    return fresh
  }, [])

  const captureSnapshot = useCallback(async (id: string, url: string): Promise<void> => {
    const slot = slots.current.get(id)
    if (!slot?.webContentsId || slot.capturing) return
    slot.capturing = true
    // Отметка ставится на попытку, а не на успех: неудачная не должна долбиться каждый такт.
    slot.lastCaptureAt = Date.now()
    try {
      const key = snapshotKeyFor(id, url)
      const dataUrl = await window.api.snapshots.capture(slot.webContentsId)
      if (!dataUrl) return
      snapshots.current.set(key, dataUrl)
      await window.api.snapshots.save(key, dataUrl)
    } finally {
      slot.capturing = false
    }
  }, [])

  const loadSnapshot = useCallback(async (id: string, url: string): Promise<void> => {
    const key = snapshotKeyFor(id, url)
    if (snapshots.current.has(key)) return
    const stored = await window.api.snapshots.url(key)
    if (!stored) return
    snapshots.current.set(key, stored)
    forceRender((v) => v + 1)
  }, [])

  useEffect(() => {
    let promoting = false

    const evaluate = async (): Promise<void> => {
      if (promoting) return
      const state = store.snapshot
      const webNodes = state.doc.nodes.filter((n) => nodeKind(n) === 'web')
      if (webNodes.length === 0) {
        if (liveRef.current.size > 0) applyLive(new Set())
        return
      }

      const now = Date.now()
      const visibleRect = camera.visibleRect(0)
      const runtimes: WebNodeRuntime[] = webNodes.map((n) => {
        const slot = slotFor(n.id)
        const visible = rectsIntersect(nodeRect(n), visibleRect)
        if (visible) slot.lastVisibleAt = now
        return { id: n.id, visible, lastVisibleAt: slot.lastVisibleAt, live: liveRef.current.has(n.id) }
      })

      const desired = chooseLiveNodes(runtimes, {
        zoom: camera.value.zoom,
        zoomThreshold: settings.web.lodZoomThreshold,
        liveLimit: settings.web.liveLimit,
        offscreenUnloadMs: settings.web.offscreenUnloadMs,
        activeId: state.activeNodeId,
        now
      })

      // Снимаем, пока нода на экране: у гостя за краем окна кадра может не быть вовсе.
      for (const n of runtimes) {
        const node = webNodes.find((w) => w.id === n.id)
        if (!node || node.type !== 'link' || !n.live || !n.visible) continue
        const slot = slotFor(n.id)
        if (now - slot.lastCaptureAt < SNAPSHOT_REFRESH_MS) continue
        void captureSnapshot(n.id, node.url)
      }

      const current = liveRef.current
      const leaving = [...current].filter((id) => !desired.has(id))
      const joining = [...desired].filter((id) => !current.has(id))
      if (leaving.length === 0 && joining.length === 0) return

      for (const id of leaving) {
        const node = webNodes.find((n) => n.id === id)
        if (!node || node.type !== 'link') continue
        await Promise.race([
          captureSnapshot(id, node.url),
          new Promise((resolve) => setTimeout(resolve, CAPTURE_TIMEOUT_MS))
        ])
      }
      for (const id of joining) {
        const node = webNodes.find((n) => n.id === id)
        if (!node || node.type !== 'link') continue
        // Первый снимок — не раньше чем через SNAPSHOT_REFRESH_MS: белый лист не нужен.
        slotFor(id).lastCaptureAt = now
        void loadSnapshot(id, node.url)
      }

      if (joining.length <= 1) {
        applyLive(desired)
        return
      }

      // Поднимаем по одной с паузой: ТЗ 5.4 — «живыми становятся по очереди».
      promoting = true
      const next = new Set([...current].filter((id) => !leaving.includes(id)))
      applyLive(new Set(next))
      for (const id of joining) {
        await new Promise((r) => setTimeout(r, PROMOTE_STEP_MS))
        next.add(id)
        applyLive(new Set(next))
      }
      promoting = false
    }

    void evaluate()
    const timer = setInterval(() => void evaluate(), TICK_MS)
    const offCamera = camera.subscribeFrame(() => void evaluate())
    const offStore = store.subscribe(() => void evaluate())
    return () => {
      clearInterval(timer)
      offCamera()
      offStore()
    }
  }, [store, camera, settings.web, slotFor, captureSnapshot, loadSnapshot, applyLive])

  useEffect(() => {
    const byGuestId = (guestId: number): string | null => {
      for (const [id, slot] of slots.current) if (slot.webContentsId === guestId) return id
      return null
    }
    const offEscape = window.api.web.onGuestEscape((guestId) => {
      const id = byGuestId(guestId)
      if (id && store.snapshot.activeNodeId === id) store.setActiveNode(null)
    })
    return offEscape
  }, [store])

  const runtime = useMemo<WebRuntime>(
    () => ({
      isLive: (id) => liveIds.has(id),
      snapshotFor: (id) => {
        const node = store.doc.nodes.find((n) => n.id === id)
        if (!node || node.type !== 'link') return null
        return snapshots.current.get(snapshotKeyFor(id, node.url)) ?? null
      },
      registerGuest: (id, el) => {
        slotFor(id).el = el
        if (!el) slotFor(id).webContentsId = null
      },
      noteGuestId: (id, webContentsId) => {
        slotFor(id).webContentsId = webContentsId
      }
    }),
    [liveIds, store, slotFor]
  )

  return { runtime, liveIds }
}
