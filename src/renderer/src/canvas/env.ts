import { createContext, useContext } from 'react'
import type { CameraController } from '@core/camera-controller'
import type { DocStore } from '@core/doc-store'
import type { Settings } from '@shared/settings'
import type { NodeViewStateApi } from '@renderer/workspace/useCanvasFile'

/** `label` — подпись группы. */
export type IdentityField = 'name' | 'role' | 'icon' | 'label'

export type CardTarget = { card: string } | { lane: string }

export interface CanvasEnv {
  store: DocStore
  camera: CameraController
  settings: Settings
  /** Состояние вида ноды (страница PDF и т.п.) — живёт в самом .canvas под x-cnv. */
  viewState: NodeViewStateApi
  /** Открыть диалог имени, роли или значка ноды — тот же, что F2 и «Роль…» в меню. */
  editIdentity(nodeId: string, field: IdentityField): void
  /** Пипетка маски по цвету над картинкой. */
  startEyedropper(nodeId: string): void
  /** «Продолжить сессию…» для агента. */
  pickSession(nodeId: string): void
  /** Редактор карточки доски: своей (`card`) или новой в дорожке (`lane`). */
  editCard(boardId: string, target: CardTarget): void
  /**
   * Холст рисуется для снимка в скрытом окне: терминалы и веб-страницы — не живые, а
   * текстом экрана и готовым кадром из окна холста.
   */
  snapshot?: { terminals: Record<string, string>; web: Record<string, string> }
}

export const CanvasEnvContext = createContext<CanvasEnv | null>(null)

export function useCanvasEnv(): CanvasEnv {
  const env = useContext(CanvasEnvContext)
  if (!env) throw new Error('CanvasEnvContext не установлен')
  return env
}
