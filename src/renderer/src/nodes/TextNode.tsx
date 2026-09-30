import { useEffect, useMemo, useRef } from 'react'
import type { TextNode as TextNodeModel } from '@shared/canvas'
import type { DocNode } from '@core/document'
import { insertNodes, makeNode, patchNodes } from '@core/ops'
import { useCanvasEnv } from '@renderer/canvas/env'
import { markdownSummary, renderMarkdown } from './markdown'
import { MarkdownEditor } from './MarkdownEditor'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & TextNodeModel>

export function TextNodeView({ node, active }: Props): React.JSX.Element {
  const { store, settings } = useCanvasEnv()
  const html = useMemo(() => renderMarkdown(node.text), [node.text])
  const viewRef = useRef<HTMLDivElement>(null)
  const textAtActivation = useRef(node.text)

  useEffect(() => {
    if (!active) return
    const before = store.doc.nodes.find((n) => n.id === node.id)
    textAtActivation.current = before && before.type === 'text' ? before.text : node.text
    return () => {
      store.recordNodePatch('правка текста', node.id, { text: textAtActivation.current } as Partial<DocNode>)
    }
  }, [active, node.id, node.text, store])

  // Авто-высота: карточка растёт под содержимое, не заводя записи в истории.
  useEffect(() => {
    const el = viewRef.current
    if (!settings.nodes.textAutoHeight || active || !el) return
    const fit = (): void => {
      const needed = Math.ceil(el.scrollHeight) + 2
      if (needed <= node.height || Math.abs(needed - node.height) < 2) return
      store.mutateSilent((doc) => patchNodes(doc, new Map([[node.id, { height: needed }]])))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [settings.nodes.textAutoHeight, active, node.id, node.height, html, store])

  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const onClick = (e: MouseEvent): void => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (!anchor) return
      e.preventDefault()
      e.stopPropagation()
      const href = anchor.dataset.href ?? ''
      if (!href) return
      if (anchor.dataset.workspace) {
        void window.api.files.openInSystem(href)
        return
      }
      if (e.ctrlKey || e.metaKey) {
        const size = settings.nodes.defaultWebSize
        store.mutate('веб-нода из ссылки', (doc) =>
          insertNodes(doc, [
            makeNode(
              { type: 'link', url: href },
              {
                x: node.x + node.width + 40,
                y: node.y,
                width: size.width,
                height: size.height
              }
            )
          ])
        )
        return
      }
      void window.api.shell.openExternal(href)
    }
    // Прокрутка длинной карточки колесом без входа в режим правки. Пока есть что
    // скроллить и мы не в конце по ходу движения — колесо наше, холст не трогаем
    // (гасим всплытие до его обработчика). На границе отпускаем колесо холсту, чтобы
    // над карточкой можно было и панорамировать.
    const onWheel = (e: WheelEvent): void => {
      const canScroll = el.scrollHeight - el.clientHeight > 1
      if (!canScroll) return
      const atTop = el.scrollTop <= 0
      const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) return
      e.stopPropagation()
    }

    el.addEventListener('click', onClick)
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('click', onClick)
      el.removeEventListener('wheel', onWheel)
    }
  }, [store, settings, node.x, node.y, node.width, node.height])

  if (active) {
    return (
      <MarkdownEditor
        value={node.text}
        onChange={(text) => store.mutateSilent((doc) => patchNodes(doc, new Map([[node.id, { text }]])))}
      />
    )
  }

  return (
    <div
      className="node-text"
      ref={viewRef}
      /* markdown уже прогнан через DOMPurify в renderMarkdown */
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function TextNodeLowDetail({ node }: Props): React.JSX.Element {
  return <div className="node-text node-text--lod">{markdownSummary(node.text)}</div>
}
