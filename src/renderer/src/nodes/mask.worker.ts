import { applyColorMask } from '@core/color-mask'
import type { ColorKey } from '@core/image-edit'

interface MaskRequest {
  id: number
  bitmap: ImageBitmap
  keys: ColorKey[]
  maxSide: number
}

/**
 * Воркер маски: рисуем битмап в OffscreenCanvas (с ограничением стороны), выбиваем альфу
 * у попавших в ключи пикселей и отдаём PNG-blob. Тяжёлый проход пикселей не морозит UI.
 */
self.onmessage = async (e: MessageEvent<MaskRequest>): Promise<void> => {
  const { id, bitmap, keys, maxSide } = e.data
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const img = ctx.getImageData(0, 0, w, h)
  applyColorMask(img.data, keys)
  ctx.putImageData(img, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  self.postMessage({ id, blob })
}
