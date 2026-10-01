import { maskCacheKey } from '@core/color-mask'
import type { ColorKey } from '@core/image-edit'

/** Ограничение стороны обрабатываемой картинки — защита от гигантских исходников. */
const MAX_SIDE = 2048
/** Сколько готовых масок держим в памяти (object URL каждая). */
const CACHE_LIMIT = 24

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (blob: Blob) => void>()
const cache = new Map<string, string>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./mask.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; blob: Blob }>): void => {
      const resolve = pending.get(e.data.id)
      if (resolve) {
        pending.delete(e.data.id)
        resolve(e.data.blob)
      }
    }
  }
  return worker
}

/**
 * Готовит картинку с выбитыми по цвет-ключам пикселями и возвращает object URL. Результат
 * кэшируется по файлу+параметрам; старые URL отзываются при вытеснении.
 */
export async function requestMask(url: string, file: string, keys: readonly ColorKey[]): Promise<string> {
  const key = maskCacheKey(file, keys)
  const hit = cache.get(key)
  if (hit) return hit

  const blob = await fetch(url).then((r) => r.blob())
  const bitmap = await createImageBitmap(blob)
  const out = await new Promise<Blob>((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    getWorker().postMessage({ id, bitmap, keys: [...keys], maxSide: MAX_SIDE }, [bitmap])
  })

  const objUrl = URL.createObjectURL(out)
  cache.set(key, objUrl)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      URL.revokeObjectURL(cache.get(oldest) as string)
      cache.delete(oldest)
    }
  }
  return objUrl
}
