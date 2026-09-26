import { useEffect, useState } from 'react'
import { patchNodes } from '@core/ops'
import { useCanvasEnv } from '@renderer/canvas/env'
import { fitToAspect, loadImageSize } from './image-size'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

export function ImageNodeView({ node }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const [failed, setFailed] = useState(false)
  const src = window.api.files.url(node.file)

  // Рамка ноды повторяет пропорции картинки: тянем за угол — тянется сама картинка.
  useEffect(() => {
    let cancelled = false
    void loadImageSize(node.file).then((natural) => {
      if (cancelled || !natural) return
      const height = fitToAspect(node.width, natural)
      if (Math.abs(height - node.height) < 1) return
      store.mutateSilent((doc) => patchNodes(doc, new Map([[node.id, { height }]])))
    })
    return () => {
      cancelled = true
    }
  }, [node.id, node.file, node.width, node.height, store])

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
