import { useSyncExternalStore } from 'react'
import type { DocState, DocStore } from '@core/doc-store'

export function useDocState(store: DocStore): DocState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.snapshot
  )
}
