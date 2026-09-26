import type { GroupNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & GroupNode>

export function GroupNodeView({ node }: Props): React.JSX.Element {
  return (
    <div className="node-group">
      <div className="node-group__label">{node.label ?? ''}</div>
    </div>
  )
}
