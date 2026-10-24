import { useEffect, useState } from 'react'

/**
 * Импульсы по связям: агент обратился к соседу (написал, прочитал, поправил) — по стрелке
 * между ними пробегает светящаяся точка, от того, кто обратился, к тому, к кому. Видно,
 * кто с кем сейчас разговаривает.
 */
export interface EdgePulse {
  key: number
  edge: string
  /** Бежит против стрелки: обратился тот, к кому она ведёт. */
  reverse: boolean
}

/**
 * Импульс «по воздуху» — между нодами без стрелки: агент сходил на сайт (web_fetch), который
 * открыт страницей на холсте. Летит по такой же дуге, какой была бы стрелка, и тает.
 */
export interface GhostPulse {
  key: number
  from: string
  to: string
}

/** Сколько длится пробег, мс. */
export const PULSE_MS = 900

let pulses: EdgePulse[] = []
let ghosts: GhostPulse[] = []
let next = 1
const listeners = new Set<() => void>()

const publish = (): void => {
  for (const l of listeners) l()
}

export function pulseEdge(edge: string, reverse: boolean): void {
  // Один и тот же импульс подряд (агент дёрнул соседа несколько раз за миг) — не копим.
  if (pulses.some((p) => p.edge === edge && p.reverse === reverse)) return
  const pulse = { key: next++, edge, reverse }
  pulses = [...pulses, pulse]
  publish()
  setTimeout(() => {
    pulses = pulses.filter((p) => p !== pulse)
    publish()
  }, PULSE_MS)
}

export function pulseGhost(from: string, to: string): void {
  if (from === to || ghosts.some((g) => g.from === from && g.to === to)) return
  const ghost = { key: next++, from, to }
  ghosts = [...ghosts, ghost]
  publish()
  setTimeout(() => {
    ghosts = ghosts.filter((g) => g !== ghost)
    publish()
  }, PULSE_MS)
}

export function useEdgePulses(): { pulses: EdgePulse[]; ghosts: GhostPulse[] } {
  const [state, setState] = useState({ pulses, ghosts })
  useEffect(() => {
    const update = (): void => setState({ pulses, ghosts })
    listeners.add(update)
    return () => {
      listeners.delete(update)
    }
  }, [])
  return state
}
