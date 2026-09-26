export interface WebNodeRuntime {
  id: string
  /** Пересекается ли нода с видимой областью прямо сейчас. */
  visible: boolean
  /** Когда нода последний раз была видима. */
  lastVisibleAt: number
  /** Сейчас нода живая (реальный webview), а не снимок. */
  live: boolean
}

export interface LifecycleParams {
  zoom: number
  /** 0 — zoom не выгружает. */
  zoomThreshold: number
  /** 0 — без лимита. */
  liveLimit: number
  /** 0 — за экраном не выгружать. */
  offscreenUnloadMs: number
  activeId: string | null
  now: number
}

/**
 * Какие веб-ноды должны быть живыми. Активная — всегда, остальные по правилам ТЗ 5.4:
 * ниже порога zoom живых нет, вне viewport дольше N мс — на выгрузку, сверх лимита —
 * вытесняется та, что дольше всех не показывалась.
 *
 * Каждый из трёх порогов выключается нулём, и по умолчанию выключены все три: страница
 * с открытой сессией дороже той памяти, что экономит выгрузка. Один раз увиденная нода
 * остаётся живой; ни разу не показанная гостя не поднимает — иначе открытие канваса
 * сразу поднимало бы всех.
 */
export function chooseLiveNodes(nodes: readonly WebNodeRuntime[], p: LifecycleParams): Set<string> {
  const result = new Set<string>()
  const active = p.activeId && nodes.some((n) => n.id === p.activeId) ? p.activeId : null
  if (active) result.add(active)

  if (p.zoomThreshold > 0 && p.zoom < p.zoomThreshold) return result

  const candidates = nodes.filter((n) => {
    if (n.id === active) return false
    if (n.visible) return true
    if (!n.live) return false
    return p.offscreenUnloadMs <= 0 || p.now - n.lastVisibleAt < p.offscreenUnloadMs
  })

  candidates.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1
    if (a.lastVisibleAt !== b.lastVisibleAt) return b.lastVisibleAt - a.lastVisibleAt
    return a.id < b.id ? -1 : 1
  })

  const limit = p.liveLimit > 0 ? Math.max(p.liveLimit, active ? 1 : 0) : Infinity
  for (const n of candidates) {
    if (result.size >= limit) break
    result.add(n.id)
  }
  return result
}

/** Ключ кеша снимка: своя картинка на каждый адрес, иначе после навигации покажем чужое. */
export const snapshotKeyFor = (nodeId: string, url: string): string => `${nodeId}::${url}`
