import { useEffect, useState } from 'react'
import { patchNodes } from '@core/ops'
import { cropAspect, cropStyle, imageEdit } from '@core/image-edit'
import { useCanvasEnv } from '@renderer/canvas/env'
import { loadImageSize } from './image-size'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

export function ImageNodeView({ node }: Props): React.JSX.Element {
  const { store } = useCanvasEnv()
  const [failed, setFailed] = useState(false)
  const src = window.api.files.url(node.file)
  const edit = imageEdit(node)
  const crop = edit?.crop
  const sized = edit?.sized ?? false

  // Рамка ноды повторяет пропорции видимой (кропнутой) картинки: тянем за угол — тянется
  // сама картинка. Молчим, если юзер уже задал размер руками.
  useEffect(() => {
    if (sized) return
    let cancelled = false
    void loadImageSize(node.file).then((natural) => {
      if (cancelled || !natural) return
      const aspect = cropAspect(natural.width, natural.height, crop)
      const height = Math.round(node.width / aspect)
      if (!Number.isFinite(height) || Math.abs(height - node.height) < 1) return
      store.mutateSilent((doc) => patchNodes(doc, new Map([[node.id, { height }]])))
    })
    return () => {
      cancelled = true
    }
    // crop участвует через свои примитивы — объект пересоздаётся каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.file, node.width, node.height, sized, crop?.x, crop?.y, crop?.w, crop?.h, store])

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

  const imgStyle: React.CSSProperties | undefined = crop
    ? (() => {
        const s = cropStyle(crop)
        return {
          position: 'absolute',
          width: `${s.width}%`,
          height: `${s.height}%`,
          left: `${s.left}%`,
          top: `${s.top}%`
        }
      })()
    : undefined

  return (
    <div className="node-image-wrap">
      <img
        className="node-image"
        src={src}
        style={imgStyle}
        alt={node.file}
        draggable={false}
        onError={() => setFailed(true)}
      />
    </div>
  )
}
