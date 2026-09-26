import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

/** Заглушка до Фазы 5: постраничный рендер через pdf.js. */
export function PdfNodeView({ node }: Props): React.JSX.Element {
  const name = node.file.split('/').pop() ?? node.file
  return (
    <div className="node-file">
      <div className="node-file__name" title={node.file}>
        {name}
      </div>
      <button type="button" onClick={() => void window.api.files.openInSystem(node.file)}>
        Открыть в системе
      </button>
    </div>
  )
}
