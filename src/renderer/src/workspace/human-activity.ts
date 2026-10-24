/**
 * Когда человек последний раз водил мышью или крутил колесо в окне. Пока он работает, агенты
 * не забирают у него камеру: zoom_to, смена стола и команды вида ждут, пока он отпустит
 * мышь, — иначе экран уезжает из-под руки посреди дела.
 */
let lastInputAt = 0

export const CAMERA_GUARD_MS = 10_000

const note = (e: Event): void => {
  if (e.isTrusted) lastInputAt = Date.now()
}

export function trackHumanInput(): () => void {
  const events = ['pointermove', 'pointerdown', 'wheel'] as const
  for (const type of events) window.addEventListener(type, note, { capture: true, passive: true })
  return () => {
    for (const type of events) window.removeEventListener(type, note, { capture: true })
  }
}

/** Сколько секунд назад человек трогал мышь, если это было недавно; иначе null. */
export function humanBusy(now = Date.now()): number | null {
  const ago = now - lastInputAt
  return ago < CAMERA_GUARD_MS ? Math.max(1, Math.round(ago / 1000)) : null
}
