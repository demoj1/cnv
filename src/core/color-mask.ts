import type { ColorKey } from './image-edit'

/** Максимальное евклидово расстояние в RGB — для нормировки допуска в 0..1. */
const MAX_DIST = Math.sqrt(3 * 255 * 255)

export type Rgb = [number, number, number]

/** `#rgb` или `#rrggbb` → [r,g,b]. Мусор превращается в чёрный, а не роняет. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  if (full.length !== 6 || Number.isNaN(n)) return [0, 0, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** [r,g,b] → `#rrggbb`. */
export function rgbToHex([r, g, b]: Rgb): string {
  const to = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** Попадает ли пиксель в ключ с учётом допуска (0..1 от максимума RGB-расстояния). */
export function matchesKey(r: number, g: number, b: number, key: ColorKey): boolean {
  const [kr, kg, kb] = hexToRgb(key.color)
  const dist = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2)
  return dist / MAX_DIST <= key.tolerance
}

/**
 * Выбивает альфу в 0 у пикселей, попавших хотя бы в один цвет-ключ. Мутирует `data`
 * (RGBA) на месте — ровно то, что отдаёт `getImageData`.
 */
export function applyColorMask(data: Uint8ClampedArray, keys: readonly ColorKey[]): void {
  if (keys.length === 0) return
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    for (const key of keys) {
      if (matchesKey(r, g, b, key)) {
        data[i + 3] = 0
        break
      }
    }
  }
}

/** Ключ кэша маски: файл + все цвет-ключи с допусками. */
export function maskCacheKey(file: string, keys: readonly ColorKey[]): string {
  return `${file}|${keys.map((k) => `${k.color}@${k.tolerance.toFixed(3)}`).join(',')}`
}
