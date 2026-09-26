import { memo, useEffect, useRef } from 'react'
import type { DocNode } from '@core/document'
import { nodeTypeFor } from '@renderer/nodes/registry'
import { NodeErrorBoundary } from './NodeErrorBoundary'

interface Props {
  node: DocNode
  selected: boolean
  active: boolean
  lowDetail: boolean
  refs: Map<string, HTMLElement>
}

function NodeViewImpl({ node, selected, active, lowDetail, refs }: Props): React.JSX.Element {
  const def = nodeTypeFor(node)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    refs.set(node.id, el)
    return () => {
      refs.delete(node.id)
    }
  }, [node.id, refs])

  const Low = def.renderLowDetail
  const Body = lowDetail && Low ? Low : def.render

  const className = [
    'node',
    `node--${def.kind}`,
    selected ? 'node--selected' : '',
    active ? 'node--active' : '',
    node.color ? `node--color-${node.color.replace('#', 'hex')}` : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={ref}
      className={className}
      data-node-id={node.id}
      data-node-kind={def.kind}
      style={{
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${node.width}px`,
        height: `${node.height}px`,
        ...(node.color?.startsWith('#') ? { '--node-color': node.color } : {})
      }}
    >
      <NodeErrorBoundary nodeId={node.id}>
        <Body key={bodyKey(node)} node={node} selected={selected} active={active} lowDetail={lowDetail} />
      </NodeErrorBoundary>
    </div>
  )
}

/**
 * Смена источника должна сбрасывать внутреннее состояние ноды (например, флаг ошибки
 * загрузки). Адрес веб-ноды сюда не входит: его правит и сам гость при навигации, а
 * пересоздание убило бы страницу, её сессию и историю переходов — гостя туда водит
 * сама WebNodeView.
 */
function bodyKey(node: DocNode): string {
  switch (node.type) {
    case 'file':
      return node.file
    default:
      return node.id
  }
}

export const NodeView = memo(NodeViewImpl)
