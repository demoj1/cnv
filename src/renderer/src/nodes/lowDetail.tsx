import type { FileNode, GroupNode, LinkNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

const baseName = (path: string): string => path.split('/').pop() ?? path

/** При малом zoom ноды рисуются дёшево: ни pdf.js, ни webview, ни полного markdown. */
export function FileLowDetail({ node }: NodeViewProps<DocNode & FileNode>): React.JSX.Element {
  return <div className="node-lod">{baseName(node.file)}</div>
}

export function WebLowDetail({ node }: NodeViewProps<DocNode & LinkNode>): React.JSX.Element {
  let host = node.url
  try {
    host = new URL(node.url).host
  } catch {
    /* оставляем адрес как есть */
  }
  return <div className="node-lod">{host}</div>
}

export function GroupLowDetail({ node }: NodeViewProps<DocNode & GroupNode>): React.JSX.Element {
  return <div className="node-group__label">{node.label ?? ''}</div>
}
