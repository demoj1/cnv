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

/** Сколько длится пробег, мс. */
export const PULSE_MS = 900

let pulses: EdgePulse[] = []
let next = 1
const listeners = new Set<(list: EdgePulse[]) => void>()

const publish = (): void => {
  for (const l of listeners) l(pulses)
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

export function useEdgePulses(): EdgePulse[] {
  const [list, setList] = useState(pulses)
  useEffect(() => {
    listeners.add(setList)
    return () => {
      listeners.delete(setList)
    }
  }, [])
  return list
}
