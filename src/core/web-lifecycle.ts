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
  zoomThreshold: number
  liveLimit: number
  offscreenUnloadMs: number
  activeId: string | null
  now: number
}

/**
 * Какие веб-ноды должны быть живыми. Активная — всегда, остальные по правилам ТЗ 5.4:
 * ниже порога zoom живых нет, вне viewport дольше N мс — на выгрузку, сверх лимита —
 * вытесняется та, что дольше всех не показывалась.
 */
export function chooseLiveNodes(nodes: readonly WebNodeRuntime[], p: LifecycleParams): Set<string> {
  const result = new Set<string>()
  const active = p.activeId && nodes.some((n) => n.id === p.activeId) ? p.activeId : null
  if (active) result.add(active)

  if (p.zoom < p.zoomThreshold) return result

  const candidates = nodes.filter((n) => {
    if (n.id === active) return false
    if (n.visible) return true
    return n.live && p.now - n.lastVisibleAt < p.offscreenUnloadMs
  })

  candidates.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1
    if (a.lastVisibleAt !== b.lastVisibleAt) return b.lastVisibleAt - a.lastVisibleAt
    return a.id < b.id ? -1 : 1
  })

  for (const n of candidates) {
    if (result.size >= Math.max(p.liveLimit, active ? 1 : 0)) break
    result.add(n.id)
  }
  return result
}

/** Ключ кеша снимка: своя картинка на каждый адрес, иначе после навигации покажем чужое. */
export const snapshotKeyFor = (nodeId: string, url: string): string => `${nodeId}::${url}`
