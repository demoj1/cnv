import { useEffect } from 'react'
import type { DocStore } from '@core/doc-store'
import { staleEdgeSides } from '@core/edges'
import { patchEdge } from '@core/ops'

/** Ноды двигаются — стороны связей уезжают вместе с ними, но реже, чем кадр. */
const SETTLE_MS = 200

/**
 * Рисуем связи по текущему расположению нод, а в документ подобранные стороны
 * дописываем отдельно и мимо истории: иначе файл разошёлся бы с картинкой и в Obsidian
 * связь ушла бы в другую сторону.
 */
export function useAutoEdgeSides(store: DocStore, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null

    const sync = (): void => {
      timer = null
      if (store.inTransaction) return
      const changed = staleEdgeSides(store.doc)
      if (changed.size === 0) return
      store.mutateSilent((doc) => {
        let next = doc
        for (const [id, sides] of changed) next = patchEdge(next, id, sides)
        return next
      })
    }

    const schedule = (): void => {
      if (timer) return
      timer = setTimeout(sync, SETTLE_MS)
    }

    schedule()
    const off = store.subscribe(schedule)
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [store, enabled])
}
