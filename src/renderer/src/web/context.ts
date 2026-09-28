import { createContext, useContext } from 'react'
import type { WebviewElement } from './webview-element'

/**
 * Только методы и ничего меняющегося: объект обязан быть стабильным. Он лежит в
 * зависимостях эффекта, который создаёт `<webview>`, а пересоздание гостя — это
 * перезагрузка страницы. Живость живёт в своём контексте рядом.
 */
export interface WebRuntime {
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

export const WebLiveContext = createContext<ReadonlySet<string>>(new Set())

/**
 * Пока зажат Ctrl, над активной страницей снова висит щит: колесо в этот момент
 * принадлежит холсту, иначе масштаб менялся бы у страницы.
 */
export const WebShieldContext = createContext(false)

export const useWebShield = (): boolean => useContext(WebShieldContext)

export const useWebLive = (): ReadonlySet<string> => useContext(WebLiveContext)
