import { useEffect } from 'react'
import type { CanvasDoc } from '@core/document'
import type { DocStore } from '@core/doc-store'
import { assignIdentities } from '@core/terminal-identity'

/**
 * Следит, чтобы у каждого терминала было своё имя, а у агента — своя сессия: после
 * копии, вставки, старого файла или чужой правки. Мимо истории — это служебные поля,
 * отменять их по Ctrl+Z незачем.
 */
export function useTerminalIdentity(store: DocStore): void {
  useEffect(() => {
    let checked: CanvasDoc | null = null
    let scheduled = false
    let alive = true
    const fix = (): void => {
      scheduled = false
      if (!alive || store.doc === checked) return
      const next = assignIdentities(store.doc, () => crypto.randomUUID())
      checked = next
      if (next !== store.doc) store.mutateSilent(() => next)
    }
    // Не правим документ изнутри рассылки стора: остальные подписчики получили бы старое.
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(fix)
    }
    schedule()
    const off = store.subscribe(schedule)
    return () => {
      alive = false
      off()
    }
  }, [store])
}
