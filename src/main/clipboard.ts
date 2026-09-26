import { ClipboardItem, clipboard } from 'electron'

export const CANVAS_MIME = 'web application/x-cnv-canvas'

export interface ClipboardPayload {
  /** Фрагмент JSON Canvas, если в буфере лежит наш кусок холста или похожий текст. */
  canvas: string | null
  text: string | null
  image: { name: string; bytes: ArrayBuffer } | null
}

export async function writeCanvasFragment(fragment: string): Promise<void> {
  // Кладём и своим типом, и текстом: свой тип доживает не на всех платформах,
  // а текстом фрагмент можно вставить и в соседний редактор.
  const payload: Record<string, string> = { 'text/plain': fragment }
  try {
    await clipboard.write([new ClipboardItem({ ...payload, [CANVAS_MIME]: fragment })])
  } catch {
    await clipboard.write([new ClipboardItem(payload)])
  }
}

export async function writeText(text: string): Promise<void> {
  await clipboard.writeText(text)
}

export async function readPayload(): Promise<ClipboardPayload> {
  const items = await clipboard.read()
  const result: ClipboardPayload = { canvas: null, text: null, image: null }

  for (const item of items) {
    if (!result.canvas && item.types.includes(CANVAS_MIME)) {
      const blob = await item.getType(CANVAS_MIME)
      if (blob instanceof Blob) result.canvas = await blob.text()
    }
    if (!result.text && item.types.includes('text/plain')) {
      const blob = await item.getType('text/plain')
      if (blob instanceof Blob) result.text = await blob.text()
    }
    const imageType = item.types.find((t) => t.startsWith('image/'))
    if (!result.image && imageType) {
      const blob = await item.getType(imageType)
      if (blob instanceof Blob) {
        const ext = imageType
          .slice('image/'.length)
          .replace('jpeg', 'jpg')
          .replace(/\+xml$/, '')
        result.image = { name: `paste-${Date.now()}.${ext}`, bytes: await blob.arrayBuffer() }
      }
    }
  }

  return result
}
