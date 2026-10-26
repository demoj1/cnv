import type { DocStore } from '@core/doc-store'
import type { DocNode } from '@core/document'
import { nodeKind } from '@core/node-kind'
import { nodeTypeFor } from '@renderer/nodes/registry'

export interface OpenNodeActions {
  onCropImage(nodeId: string): void
  onRenameGroup(nodeId: string): void
}

/**
 * «Открыть» ноду — то, что делает двойной клик по ней (и Enter по выделенной): картинка —
 * обрезка, группа — подпись, нода, которая умеет принимать ввод, — становится активной
 * (терминал берёт фокус, карточка — правку). Остальным открывать нечего: false.
 */
export function openNode(store: DocStore, node: DocNode, actions: OpenNodeActions): boolean {
  if (nodeKind(node) === 'image') actions.onCropImage(node.id)
  else if (node.type === 'group') actions.onRenameGroup(node.id)
  else if (nodeTypeFor(node).interactive) store.setActiveNode(node.id)
  else return false
  return true
}
