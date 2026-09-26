import { createContext, useContext } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import type { Settings } from '@shared/settings'
import type { NodeViewStateApi } from '@renderer/workspace/useCanvasFile'

export interface CanvasEnv {
  store: DocStore
  camera: CameraController
  settings: Settings
  /** Состояние вида ноды (страница PDF и т.п.) — живёт в sidecar, не в .canvas. */
  viewState: NodeViewStateApi
}

export const CanvasEnvContext = createContext<CanvasEnv | null>(null)

export function useCanvasEnv(): CanvasEnv {
  const env = useContext(CanvasEnvContext)
  if (!env) throw new Error('CanvasEnvContext не установлен')
  return env
}
