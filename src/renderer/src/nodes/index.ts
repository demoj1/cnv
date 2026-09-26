import type { FileNode, GroupNode, LinkNode, TextNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import { registerNodeType } from './registry'
import { TextNodeLowDetail, TextNodeView } from './TextNode'
import { ImageNodeView } from './ImageNode'
import { UnknownFileView } from './FileNode'
import { GroupNodeView } from './GroupNode'
import { WebNodeView } from './WebNode'
import { PdfNodeView } from './PdfNode'

let done = false

export function registerBuiltinNodeTypes(): void {
  if (done) return
  done = true

  registerNodeType<DocNode & TextNode>({
    kind: 'text',
    render: TextNodeView,
    renderLowDetail: TextNodeLowDetail,
    interactive: true,
    defaultSize: (s) => s.nodes.defaultTextSize
  })

  registerNodeType<DocNode & FileNode>({
    kind: 'image',
    render: ImageNodeView,
    interactive: false,
    defaultSize: () => ({ width: 400, height: 300 })
  })

  registerNodeType<DocNode & FileNode>({
    kind: 'file',
    render: UnknownFileView,
    interactive: false,
    defaultSize: () => ({ width: 260, height: 100 })
  })

  registerNodeType<DocNode & LinkNode>({
    kind: 'web',
    render: WebNodeView,
    interactive: true,
    defaultSize: (s) => s.nodes.defaultWebSize
  })

  registerNodeType<DocNode & FileNode>({
    kind: 'pdf',
    render: PdfNodeView,
    interactive: true,
    defaultSize: () => ({ width: 560, height: 760 })
  })

  registerNodeType<DocNode & GroupNode>({
    kind: 'group',
    render: GroupNodeView,
    interactive: false,
    defaultSize: () => ({ width: 640, height: 400 })
  })
}
