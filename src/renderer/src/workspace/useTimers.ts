import { useEffect } from 'react'
import type { DocStore } from '@core/doc-store'
import { pulseBetween } from './useAgentBridge'
import { timerSlot, timerSpec, timerTargets } from '@core/timer'

const TICK_MS = 1000

/**
 * Часы таймеров: раз в секунду смотрим, не наступил ли у кого новый тик, и шлём его в
 * main — там письмо дождётся, пока агент освободится. Пропущенные тики (cnv был закрыт,
 * таймер только появился) не догоняем: первый взгляд на таймер лишь запоминает его тик.
 */
export function useTimers(store: DocStore): void {
  useEffect(() => {
    // id таймера → его отсчёт и последний увиденный тик.
    const seen = new Map<string, { since: number; slot: number }>()
    const tick = (): void => {
      const now = Date.now()
      const alive = new Set<string>()
      for (const node of store.doc.nodes) {
        const spec = timerSpec(node)
        if (!spec) continue
        alive.add(node.id)
        const slot = timerSlot(spec, now)
        const prev = seen.get(node.id)
        seen.set(node.id, { since: spec.since, slot })
        if (!prev || prev.since !== spec.since || slot <= prev.slot) continue
        if (spec.paused || !spec.message.trim()) continue
        const targets = timerTargets(store.doc, node.id)
        if (!targets.length) continue
        window.api.agents.timerTick({ timerId: node.id, every: spec.every, message: spec.message, targets })
        for (const t of targets) pulseBetween(store.doc, node.id, t)
      }
      for (const id of seen.keys()) if (!alive.has(id)) seen.delete(id)
    }
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [store])
}
