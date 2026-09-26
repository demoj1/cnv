import { createContext, useContext } from 'react'
import type { WebviewElement } from './webview-element'

export interface WebRuntime {
  isLive(nodeId: string): boolean
  snapshotFor(nodeId: string): string | null
  registerGuest(nodeId: string, el: WebviewElement | null): void
  noteGuestId(nodeId: string, webContentsId: number): void
}

export const WebRuntimeContext = createContext<WebRuntime | null>(null)

export function useWebRuntime(): WebRuntime {
  const runtime = useContext(WebRuntimeContext)
  if (!runtime) throw new Error('WebRuntimeContext не установлен')
  return runtime
}
