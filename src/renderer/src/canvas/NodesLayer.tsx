import { useMemo } from 'react'
import { nodeRect, renderOrder, type DocNode } from '@core/document'
import { rectsIntersect, type Rect } from '@core/geometry'
import { NodeView } from './NodeView'

interface Props {
  nodes: readonly DocNode[]
  selection: ReadonlySet<string>
  activeNodeId: string | null
  visible: Rect
  lowDetail: boolean
  refs: Map<string, HTMLElement>
}

export function NodesLayer({
  nodes,
  selection,
  activeNodeId,
  visible,
  lowDetail,
  refs
}: Props): React.JSX.Element {
  const shown = useMemo(
    () => renderOrder(nodes).filter((n) => n.id === activeNodeId || rectsIntersect(nodeRect(n), visible)),
    [nodes, visible, activeNodeId]
  )

  return (
    <>
      {shown.map((node) => (
        <NodeView
          key={node.id}
          node={node}
          selected={selection.has(node.id)}
          active={activeNodeId === node.id}
          lowDetail={lowDetail}
          refs={refs}
        />
      ))}
    </>
  )
}
