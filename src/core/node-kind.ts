import type { DocNode } from './document'
import { isTerminal } from './terminal'
import { isPortal } from './portal'
import { isTimer } from './timer'
import { isBoard } from './board'

export type NodeKind =
  'text' | 'image' | 'pdf' | 'web' | 'group' | 'file' | 'terminal' | 'portal' | 'timer' | 'board'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico'])

export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function nodeKind(node: DocNode): NodeKind {
  switch (node.type) {
    case 'text':
      return isTerminal(node)
        ? 'terminal'
        : isPortal(node)
          ? 'portal'
          : isTimer(node)
            ? 'timer'
            : isBoard(node)
              ? 'board'
              : 'text'
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
export const isMarkdownFile = (path: string): boolean => ['md', 'markdown'].includes(extensionOf(path))

/** Текстовые форматы: файл-нода с таким файлом показывает его содержимое, а не плашку. */
const TEXT_EXT = new Set([
  'md',
  'markdown',
  'txt',
  'text',
  'log',
  'rst',
  'org',
  'adoc',
  'dot',
  'gv',
  'mmd',
  'puml',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'xml',
  'sql',
  'sh',
  'py',
  'js',
  'ts',
  'ex',
  'exs',
  'go',
  'rs'
])
export const isTextFile = (path: string): boolean => TEXT_EXT.has(extensionOf(path))

/** Размер новой ноды текстового файла — как у карточки, чтобы содержимое было видно. */
export const TEXT_FILE_SIZE = { width: 480, height: 360 }
export const isHtmlFile = (path: string): boolean => ['html', 'htm'].includes(extensionOf(path))
