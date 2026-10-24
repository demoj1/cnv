import type { ComponentType, ReactNode } from 'react'
import type { DocNode } from '@core/document'
import type { CanvasEnv } from '@renderer/canvas/env'

/**
 * Кнопки и панели нод — одним способом. Любое действие над нодой регистрируется здесь и
 * само встаёт в своё место:
 *
 * - `header` — в шапку ноды, у которой она есть (терминал, веб-страница), справа от имени
 *   и роли;
 * - `panel` — в панель под выделенной нодой у всех остальных (карточка, картинка, файл,
 *   PDF, группа): свёрнутая — одна кнопка со сводкой, раскрытая — секции действий.
 *
 * Новая кнопка — одна регистрация: ни App, ни сами ноды трогать не надо.
 */

export type NodeActionSlot = 'header' | 'panel'

export interface NodeActionContext {
  node: DocNode
  env: CanvasEnv
}

export interface NodeAction {
  id: string
  /** Подпись для подсказки и доступности. */
  label: string
  /** Куда встаёт; несколько — во все. */
  slots: readonly NodeActionSlot[]
  /** Для каких нод. */
  when(node: DocNode): boolean
  /** Порядок слева направо: меньше — левее. */
  order: number
  /** Сводка на свёрнутой панели: «Aa», цвет точкой, число масок. */
  summary?(ctx: NodeActionContext): ReactNode
  /** Сам виджет: кнопка, палитра, слайдер. `slot` — где рисуется: в шапке места меньше. */
  render: ComponentType<NodeActionContext & { slot: NodeActionSlot }>
}

const actions: NodeAction[] = []

export function registerNodeAction(action: NodeAction): void {
  if (actions.some((a) => a.id === action.id)) throw new Error(`действие ${action.id} уже есть`)
  actions.push(action)
  actions.sort((a, b) => a.order - b.order)
}

export function nodeActions(node: DocNode, slot: NodeActionSlot): NodeAction[] {
  return actions.filter((a) => a.slots.includes(slot) && a.when(node))
}
