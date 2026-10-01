import { memo, useEffect, useRef } from 'react'
import type { DocNode } from '@core/document'
import { nodeRotate } from '@core/image-edit'
import { nodeTypeFor } from '@renderer/nodes/registry'
import { NodeErrorBoundary } from './NodeErrorBoundary'

interface Props {
  node: DocNode
  selected: boolean
  active: boolean
  lowDetail: boolean
  /** Позиция в порядке отрисовки — она же z-index, чтобы связи вставали между нодами. */
  z: number
  refs: Map<string, HTMLElement>
}

function NodeViewImpl({ node, selected, active, lowDetail, z, refs }: Props): React.JSX.Element {
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

  // Поворот крутим всю рамку вокруг центра: border, тень и контент заодно. Хранимый
  // прямоугольник (left/top/width/height) при этом неповёрнутый — привязки и хит-тест по
  // AABB не трогаем.
  const rotate = nodeRotate(node)

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
      // Пока нода активна и умеет принимать мышь, колесо и прокрутка её, а не холста.
      // Один источник правды — реестр: класс `node--active` для этого не годится,
      // активной бывает и картинка, которой мышь не нужна.
      data-owns-input={active && def.interactive ? 'true' : undefined}
      style={{
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${node.width}px`,
        height: `${node.height}px`,
        zIndex: z,
        ...(rotate ? { transform: `rotate(${rotate}deg)` } : {}),
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
