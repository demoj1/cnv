/**
 * Натуральные размеры картинок. Спрашиваем у main (nativeImage), а не у DOM: у уже
 * раскодированной картинки событие `load` успевает пройти мимо обработчика React.
 */
const sizes = new Map<string, { width: number; height: number } | null>()
const pending = new Map<string, Promise<{ width: number; height: number } | null>>()

export function knownImageSize(file: string): { width: number; height: number } | null | undefined {
  return sizes.get(file)
}

export function imageAspect(file: string): number | null {
  const size = sizes.get(file)
  return size && size.height > 0 ? size.width / size.height : null
}

export async function loadImageSize(file: string): Promise<{ width: number; height: number } | null> {
  const known = sizes.get(file)
  if (known !== undefined) return known
  const running = pending.get(file)
  if (running) return running
  const task = window.api.files.imageSize(file).then((size) => {
    sizes.set(file, size)
    pending.delete(file)
    return size
  })
  pending.set(file, task)
  return task
}

/** Размер ноды под картинку: ширину держим, высоту считаем по пропорции. */
export function fitToAspect(width: number, natural: { width: number; height: number }): number {
  if (natural.width <= 0 || natural.height <= 0) return width
  return Math.round((width * natural.height) / natural.width)
}
