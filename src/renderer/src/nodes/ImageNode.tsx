import { useState } from 'react'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

export function ImageNodeView({ node }: Props): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const src = window.api.files.url(node.file)

  if (failed) {
    return (
      <div className="node-error">
        <div className="node-error__title">Картинка не загрузилась</div>
        <div className="node-error__detail">{node.file}</div>
        <button type="button" onClick={() => setFailed(false)}>
          Повторить
        </button>
      </div>
    )
  }

  return (
    <img className="node-image" src={src} alt={node.file} draggable={false} onError={() => setFailed(true)} />
  )
}
