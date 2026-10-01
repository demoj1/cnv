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
  const ordered = useMemo(() => renderOrder(nodes), [nodes])
  // Индекс в порядке отрисовки = z-index ноды; его же берут связи, чтобы встать между нод.
  const zOf = useMemo(() => {
    const m = new Map<string, number>()
    ordered.forEach((n, i) => m.set(n.id, i * 2))
    return m
  }, [ordered])
  const shown = useMemo(
    () =>
      ordered.filter(
        (n) => n.id === activeNodeId || keepMounted.has(n.id) || rectsIntersect(visualBounds(n), visible)
      ),
    [ordered, visible, activeNodeId, keepMounted]
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
          z={zOf.get(node.id) ?? 0}
          refs={refs}
        />
      ))}
    </>
  )
}
