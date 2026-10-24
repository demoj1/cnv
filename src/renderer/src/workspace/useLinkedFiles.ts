import { useEffect } from 'react'
import type { DocStore } from '@core/doc-store'
import type { LinkedFile } from '@shared/api'
import { fileSource } from '@core/ops'
import { bumpFileVersion } from './file-versions'

/** Ноды двигаются часто, а список файлов меняется редко — сверяем его не чаще этого. */
const SYNC_MS = 300

/**
 * Файлы нод на диске: main слушает их через inotify и говорит, что поменялось, — нода
 * перерисовывается. Копия снаружи workspace (`x-cnv.source`) следует за оригиналом: main
 * перекопирует её сам, а изменение копии придёт сюда же, как изменение файла workspace.
 */
export function useLinkedFiles(store: DocStore): void {
  useEffect(() => {
    let last = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const sync = (): void => {
      timer = null
      const files: LinkedFile[] = []
      for (const node of store.doc.nodes) {
        if (node.type !== 'file') continue
        const source = fileSource(node)
        files.push({ relPath: node.file, ...(source ? { source } : {}) })
      }
      const key = JSON.stringify(files)
      if (key === last) return
      last = key
      window.api.files.track(files)
    }
    const schedule = (): void => {
      if (!timer) timer = setTimeout(sync, SYNC_MS)
    }
    sync()
    const off = store.subscribe(schedule)
    const offChanged = window.api.files.onChanged((relPath) => bumpFileVersion(relPath))
    return () => {
      off()
      offChanged()
      if (timer) clearTimeout(timer)
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
