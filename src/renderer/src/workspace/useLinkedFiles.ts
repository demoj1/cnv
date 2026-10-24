import { useEffect } from 'react'
import type { DocStore } from '@core/doc-store'
import { fileSource } from '@core/ops'
import { bumpFileVersion } from './file-versions'

/** Как часто сверять копии с оригиналами, пока окно в фокусе. */
const CHECK_MS = 4000

/**
 * Файл, брошенный на холст снаружи workspace, копируется во вложения — но копия помнит
 * оригинал (`x-cnv.source`) и следует за ним: оригинал поменялся — копия обновляется,
 * а нода перерисовывается. Сверяемся при возврате в окно и раз в несколько секунд.
 */
export function useLinkedFiles(store: DocStore): void {
  useEffect(() => {
    let busy = false
    const check = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const seen = new Set<string>()
        for (const node of store.doc.nodes) {
          const source = fileSource(node)
          if (!source || node.type !== 'file' || seen.has(node.file)) continue
          seen.add(node.file)
          const { updated } = await window.api.attachments.refresh(node.file, source).catch(() => ({
            updated: false
          }))
          if (updated) bumpFileVersion(node.file)
        }
      } finally {
        busy = false
      }
    }
    void check()
    const timer = setInterval(() => {
      if (document.hasFocus()) void check()
    }, CHECK_MS)
    const onFocus = (): void => void check()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [store])
}

/** Обновить копии этих нод с оригиналов прямо сейчас. */
export async function refreshLinkedFiles(store: DocStore, ids: readonly string[]): Promise<string[]> {
  const updated: string[] = []
  for (const node of store.doc.nodes) {
    const source = fileSource(node)
    if (!ids.includes(node.id) || !source || node.type !== 'file') continue
    const r = await window.api.attachments.refresh(node.file, source)
    if (r.updated) {
      bumpFileVersion(node.file)
      updated.push(node.id)
    }
  }
  return updated
}
