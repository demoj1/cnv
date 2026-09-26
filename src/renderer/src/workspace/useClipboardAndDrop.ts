import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { screenToWorld } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import { fragmentFromSelection, looksLikeUrl, normalizeUrl, pasteFragment } from '@core/clipboard'
import type { DocStore } from '@core/doc-store'
import { nodeRect, type CanvasDoc } from '@core/document'
import { unionRects, type Point } from '@core/geometry'
import { isImageFile, isMarkdownFile, isPdfFile } from '@core/node-kind'
import { fitToAspect, loadImageSize } from '@renderer/nodes/image-size'
import { deleteEntities, insertNodes, makeNode } from '@core/ops'
import { parseCanvas, serializeCanvas } from '@core/serialization'
import type { Settings } from '@shared/settings'

export interface ClipboardApi {
  copy(): Promise<void>
  cut(): Promise<void>
  paste(): Promise<void>
}

const PASTE_OFFSET = 24
/** Шире этого вставленную картинку ужимаем: иначе скриншот с 4K займёт весь холст. */
const MAX_IMAGE_WIDTH = 800

export function useClipboardAndDrop(
  store: DocStore,
  camera: CameraController,
  settings: Settings,
  viewportRef: RefObject<HTMLElement | null>
): ClipboardApi {
  const cursor = useRef<Point | null>(null)

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onMove = (e: PointerEvent): void => {
      const rect = el.getBoundingClientRect()
      cursor.current = screenToWorld(camera.value, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    }
    const onLeave = (): void => {
      cursor.current = null
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [viewportRef, camera])

  const dropPoint = useCallback((): Point => {
    if (cursor.current) return cursor.current
    const v = camera.visibleRect()
    return { x: v.x + v.width / 2, y: v.y + v.height / 2 }
  }, [camera])

  const nodeForFile = useCallback(async (relPath: string, at: Point) => {
    if (isPdfFile(relPath)) {
      return makeNode({ type: 'file', file: relPath }, { x: at.x, y: at.y, width: 560, height: 760 })
    }
    if (!isImageFile(relPath)) {
      return makeNode({ type: 'file', file: relPath }, { x: at.x, y: at.y, width: 260, height: 100 })
    }
    const natural = await loadImageSize(relPath)
    const width = natural ? Math.min(natural.width, MAX_IMAGE_WIDTH) : 400
    const height = natural ? fitToAspect(width, natural) : 300
    return makeNode({ type: 'file', file: relPath }, { x: at.x, y: at.y, width, height })
  }, [])

  const copy = useCallback(async () => {
    const { doc, selection } = store.snapshot
    if (selection.size === 0) return
    await window.api.clipboard.writeCanvas(serializeCanvas(fragmentFromSelection(doc, selection)))
  }, [store])

  const cut = useCallback(async () => {
    const { selection, edgeSelection } = store.snapshot
    if (selection.size === 0) return
    await copy()
    store.mutate('вырезать', (doc) => deleteEntities(doc, selection, edgeSelection))
  }, [copy, store])

  const paste = useCallback(async () => {
    const payload = await window.api.clipboard.read()
    const at = dropPoint()

    const fragmentText = payload.canvas ?? payload.text
    if (fragmentText) {
      const fragment = tryParseFragment(fragmentText)
      if (fragment) {
        const bounds = unionRects(fragment.nodes.map(nodeRect))
        const target = cursor.current ?? {
          x: (bounds?.x ?? at.x) + PASTE_OFFSET,
          y: (bounds?.y ?? at.y) + PASTE_OFFSET
        }
        let created: string[] = []
        store.mutate('вставка', (doc) => {
          const result = pasteFragment(doc, fragment, target)
          created = result.newNodeIds
          return result.doc
        })
        if (created.length > 0) store.selectNodes(created, 'replace')
        return
      }
    }

    if (payload.image) {
      const imported = await window.api.attachments.importBytes(payload.image.name, payload.image.bytes)
      const node = await nodeForFile(imported.relPath, at)
      store.mutate('вставка картинки', (doc) => insertNodes(doc, [node]))
      return
    }

    if (payload.text) {
      if (looksLikeUrl(payload.text)) {
        const size = settings.nodes.defaultWebSize
        store.mutate('вставка ссылки', (doc) =>
          insertNodes(doc, [
            makeNode({ type: 'link', url: normalizeUrl(payload.text as string) }, { ...at, ...size })
          ])
        )
        return
      }
      const size = settings.nodes.defaultTextSize
      store.mutate('вставка текста', (doc) =>
        insertNodes(doc, [makeNode({ type: 'text', text: payload.text as string }, { ...at, ...size })])
      )
    }
  }, [store, settings, dropPoint, nodeForFile])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return

    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const transfer = e.dataTransfer
      if (!transfer) return
      const rect = el.getBoundingClientRect()
      const at = screenToWorld(camera.value, { x: e.clientX - rect.left, y: e.clientY - rect.top })

      void (async () => {
        const files = [...transfer.files]
        if (files.length > 0) {
          const created: string[] = []
          for (let i = 0; i < files.length; i++) {
            const file = files[i]
            if (!file) continue
            const source = window.api.files.pathForDrop(file)
            if (!source) continue
            const imported = await window.api.attachments.importPath(source)
            const spot = { x: at.x + i * 40, y: at.y + i * 40 }
            if (isMarkdownFile(imported.relPath) && settings.workspace.markdownDrop === 'embed-content') {
              const body = (await window.api.files.readText(imported.relPath)) ?? ''
              const size = settings.nodes.defaultTextSize
              store.mutate('markdown с диска', (doc) =>
                insertNodes(doc, [makeNode({ type: 'text', text: body }, { ...spot, ...size })])
              )
            } else {
              const node = await nodeForFile(imported.relPath, spot)
              store.mutate('файл с диска', (doc) => insertNodes(doc, [node]))
            }
            const last = store.doc.nodes[store.doc.nodes.length - 1]
            if (last) created.push(last.id)
          }
          if (created.length > 0) store.selectNodes(created, 'replace')
          return
        }

        const uri = transfer.getData('text/uri-list') || transfer.getData('text/plain')
        if (!uri) return
        const first = uri.split('\n').find((line) => line && !line.startsWith('#'))
        if (!first) return
        if (looksLikeUrl(first)) {
          const size = settings.nodes.defaultWebSize
          store.mutate('ссылка из браузера', (doc) =>
            insertNodes(doc, [makeNode({ type: 'link', url: normalizeUrl(first) }, { ...at, ...size })])
          )
          return
        }
        const size = settings.nodes.defaultTextSize
        store.mutate('текст перетаскиванием', (doc) =>
          insertNodes(doc, [makeNode({ type: 'text', text: uri }, { ...at, ...size })])
        )
      })()
    }

    el.addEventListener('dragover', onDragOver)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('drop', onDrop)
    }
  }, [viewportRef, camera, store, settings, nodeForFile])

  return { copy, cut, paste }
}

function tryParseFragment(text: string): CanvasDoc | null {
  if (!text.includes('"nodes"')) return null
  try {
    const doc = parseCanvas(text)
    return doc.nodes.length > 0 ? doc : null
  } catch {
    return null
  }
}
