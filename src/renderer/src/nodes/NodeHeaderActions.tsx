import type { DocNode } from '@core/document'
import { useCanvasEnv } from '@renderer/canvas/env'
import { nodeActions } from './actions'

/** Действия из реестра в шапке ноды (терминал, веб-страница) — справа от имени и роли. */
export function NodeHeaderActions({ node }: { node: DocNode }): React.JSX.Element | null {
  const env = useCanvasEnv()
  const actions = nodeActions(node, 'header')
  if (actions.length === 0) return null
  return (
    <span className="node-header-actions" data-testid="header-actions">
      {actions.map((a) => (
        <a.render key={a.id} node={node} env={env} slot="header" />
      ))}
    </span>
  )
}
