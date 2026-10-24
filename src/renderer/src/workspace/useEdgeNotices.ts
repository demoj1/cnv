import { useEffect } from 'react'
import type { DocStore } from '@core/doc-store'
import type { CanvasDoc } from '@core/document'
import { edgeNotices } from '@core/edge-notices'

/** Правки копим столько: пять стрелок подряд или цвет из палитры — одно письмо, а не пачка. */
const QUIET_MS = 3000

/**
 * Агентам — что поменялось в их связях и цветах. Смотрим журнал правок: загрузка холста
 * в него не пишет, а отмена и повтор — пишут (связь ведь правда пропала или вернулась).
 * Сравниваем холст до первой правки окна и после последней: туда-обратно — тишина.
 */
export function useEdgeNotices(store: DocStore): void {
  useEffect(() => {
    let seq = store.journal.at(-1)?.seq ?? 0
    // Холст на момент последней сверки и холст до первой правки открытого окна.
    let current = store.doc
    let base: CanvasDoc | null = null
    let actors = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let checking = false

    const flush = (): void => {
      timer = null
      const before = base
      base = null
      const by = actors
      actors = new Set()
      if (!before) return
      // Агент сам поменял свои связи — ему не пишем. Актор агента — «Имя (id)».
      const skip = new Set<string>()
      for (const node of store.doc.nodes) {
        if ([...by].every((a) => a.endsWith(`(${node.id})`))) skip.add(node.id)
      }
      const notices = edgeNotices(before, store.doc, skip)
      if (notices.length) window.api.agents.notify({ notices, by: [...by] })
    }

    // Сверяемся после того, как правка улеглась: отмена пишет в журнал уже после рассылки.
    const check = (): void => {
      checking = false
      if (store.inTransaction) return
      const fresh = store.journal.filter((e) => e.seq > seq)
      if (!fresh.length) {
        // Холст сменился без записи в журнал и чистый — это загрузка с диска: старое окно не в
        // счёт. Грязный — правка без разницы (diff пустой): окно живёт дальше.
        if (store.doc !== current && !store.snapshot.dirty) {
          current = store.doc
          base = null
          actors = new Set()
        }
        return
      }
      seq = fresh.at(-1)?.seq ?? seq
      base ??= current
      for (const e of fresh) actors.add(e.actor)
      current = store.doc
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, QUIET_MS)
    }

    const off = store.subscribe(() => {
      if (checking) return
      checking = true
      queueMicrotask(check)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [store])
}
