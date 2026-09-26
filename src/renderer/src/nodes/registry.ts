import type { ComponentType } from 'react'
import type { DocNode } from '@core/document'
import { nodeKind, type NodeKind } from '@core/node-kind'
import type { Size } from '@core/geometry'
import type { Settings } from '@shared/settings'

export interface NodeViewProps<N extends DocNode = DocNode> {
  node: N
  selected: boolean
  active: boolean
  lowDetail: boolean
}

export interface NodeTypeDef<N extends DocNode = DocNode> {
  kind: NodeKind
  render: ComponentType<NodeViewProps<N>>
  renderLowDetail?: ComponentType<NodeViewProps<N>>
  /** Нужен режим активации: пока нода неактивна, мышь принадлежит холсту (ТЗ 5.2). */
  interactive: boolean
  defaultSize(settings: Settings): Size
  keepAspectRatio?(node: N): number | null
}

const registry = new Map<NodeKind, NodeTypeDef>()

export function registerNodeType<N extends DocNode>(def: NodeTypeDef<N>): void {
  if (registry.has(def.kind)) throw new Error(`тип ноды ${def.kind} уже зарегистрирован`)
  // Сужение теряется на входе в реестр: соответствие «kind ноды → её определение»
  // держит `nodeKind`, и ноду другого вида в этот render никто не передаст.
  registry.set(def.kind, def as unknown as NodeTypeDef)
}

export function nodeTypeFor(node: DocNode): NodeTypeDef {
  const def = registry.get(nodeKind(node))
  if (!def) throw new Error(`нет реализации для ноды типа ${nodeKind(node)}`)
  return def
}

export const registeredKinds = (): NodeKind[] => [...registry.keys()]
