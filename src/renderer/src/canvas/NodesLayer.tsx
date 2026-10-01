import { useMemo } from 'react'
import { renderOrder, type DocNode } from '@core/document'
import { visualBounds } from '@core/image-edit'
import { rectsIntersect, type Rect } from '@core/geometry'
import { NodeView } from './NodeView'

interface Props {
  nodes: readonly DocNode[]
  selection: ReadonlySet<string>
  activeNodeId: string | null
  visible: Rect
  lowDetail: boolean
  /**
   * Ноды, которые нельзя размонтировать, что бы ни творила камера: для веб-ноды
   * размонтирование — это убитый гость, потерянная сессия и перезагрузка страницы.
   */
  keepMounted: ReadonlySet<string>
  refs: Map<string, HTMLElement>
}

export function NodesLayer({
  nodes,
  selection,
  activeNodeId,
  visible,
  lowDetail,
  keepMounted,
  refs
}: Props): React.JSX.Element {
  const shown = useMemo(
    () =>
      renderOrder(nodes).filter(
        (n) => n.id === activeNodeId || keepMounted.has(n.id) || rectsIntersect(visualBounds(n), visible)
      ),
    [nodes, visible, activeNodeId, keepMounted]
  )

  return (
    <>
      {shown.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          selected={selection.has(node.id)}
          active={activeNodeId === node.id}
          lowDetail={lowDetail && !keepMounted.has(node.id)}
          refs={refs}
        />
      ))}
    </>
  )
}
