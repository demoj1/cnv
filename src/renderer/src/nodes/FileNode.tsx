import { useEffect, useState } from 'react'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import { fileSource } from '@core/ops'
import { useFileVersion } from '@renderer/workspace/file-versions'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

const ICONS: [RegExp, string][] = [
  [/^(docx?|odt|rtf|pages)$/, '📄'],
  [/^(xlsx?|ods|csv|tsv|numbers)$/, '📊'],
  [/^(pptx?|odp|key)$/, '📽'],
  [/^(zip|rar|7z|tar|gz|bz2|xz|zst)$/, '📦'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, '🎵'],
  [/^(mp4|mkv|mov|webm|avi)$/, '🎬'],
  [/^(txt|md|log|rst|org)$/, '🗒'],
  [/^(json|ya?ml|toml|xml|ini|env)$/, '⚙'],
  [/^(ts|tsx|js|jsx|py|go|rs|c|cpp|h|java|kt|rb|sh|ex|exs|sql)$/, '💻'],
  [/^(stl|step|stp|obj|3mf|f3d|fcstd|blend)$/, '🧊']
]

const iconFor = (ext: string): string => ICONS.find(([re]) => re.test(ext))?.[1] ?? '📎'

const formatSize = (n: number): string =>
  n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`

/** Файл, который не картинка и не PDF: плашка — иконка типа, имя, размер, «открыть». */
export function UnknownFileView({ node }: Props): React.JSX.Element {
  const name = node.file.split('/').pop() ?? node.file
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  const source = fileSource(node)
  const version = useFileVersion(node.file)
  const [size, setSize] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.files.stat(node.file).then((s) => alive && setSize(s?.size ?? null))
    return () => {
      alive = false
    }
  }, [node.file, version])

  return (
    <div className="node-file" title={source ? `${node.file}\nследует за ${source}` : node.file}>
      <span className="node-file__icon">{iconFor(ext)}</span>
      <span className="node-file__text">
        <span className="node-file__name">{name}</span>
        <span className="node-file__meta">
          {[ext.toUpperCase(), size !== null ? formatSize(size) : null, source ? '🔗 с оригиналом' : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <button
        type="button"
        className="node-file__open"
        title="Открыть в системе"
        onClick={() => void window.api.files.openInSystem(node.file)}
      >
        ↗
      </button>
    </div>
  )
}
