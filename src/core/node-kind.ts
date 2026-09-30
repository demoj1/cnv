import type { DocNode } from './document'
import { isTerminal } from './terminal'

export type NodeKind = 'text' | 'image' | 'pdf' | 'web' | 'group' | 'file' | 'terminal'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico'])

export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function nodeKind(node: DocNode): NodeKind {
  switch (node.type) {
    case 'text':
      return isTerminal(node) ? 'terminal' : 'text'
    case 'link':
      return 'web'
    case 'group':
      return 'group'
    case 'file': {
      const ext = extensionOf(node.file)
      if (IMAGE_EXT.has(ext)) return 'image'
      if (ext === 'pdf') return 'pdf'
      return 'file'
    }
  }
}

export const isImageFile = (path: string): boolean => IMAGE_EXT.has(extensionOf(path))
export const isPdfFile = (path: string): boolean => extensionOf(path) === 'pdf'
export const isMarkdownFile = (path: string): boolean => extensionOf(path) === 'md'
export const isHtmlFile = (path: string): boolean => ['html', 'htm'].includes(extensionOf(path))
