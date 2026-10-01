import type { DocNode } from './document'
import type { Point, Rect } from './geometry'

/**
 * Недеструктивные правки картинки: поворот, кроп и маска прозрачности по цвету. Живут в
 * `x-cnv.image` ноды-файла, как и остальное наше состояние вне JSON Canvas — в Obsidian
 * картинка покажется оригиналом, а поля переживут round-trip.
 */
export interface ColorKey {
  color: string
  /** Допуск 0..1: насколько далеко в RGB от ключевого цвета ещё вырезаем. */
  tolerance: number
}

/** Прямоугольник кадра, нормализованный 0..1 относительно ИСХОДНОЙ картинки. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ImageEdit {
  crop?: CropRect
  /** Градусы, любой угол (поворот вокруг центра рамки). */
  rotate?: number
  colorKeys?: ColorKey[]
  /** Юзер сам менял размер — авто-подгонку высоты под пропорцию больше не навязываем. */
  sized?: boolean
}

const KEY = 'x-cnv'

const isCrop = (v: unknown): v is CropRect =>
  !!v &&
  typeof v === 'object' &&
  ['x', 'y', 'w', 'h'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')

const isColorKey = (v: unknown): v is ColorKey =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Record<string, unknown>).color === 'string' &&
  typeof (v as Record<string, unknown>).tolerance === 'number'

/** Правки картинки, или null — если это не картинка либо правок нет вовсе. */
export function imageEdit(node: DocNode): ImageEdit | null {
  if (node.type !== 'file') return null
  const own = node.extra[KEY]
  if (!own || typeof own !== 'object') return null
  const raw = (own as Record<string, unknown>).image
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const out: ImageEdit = {}
  if (isCrop(e.crop)) out.crop = { x: e.crop.x, y: e.crop.y, w: e.crop.w, h: e.crop.h }
  if (typeof e.rotate === 'number' && Number.isFinite(e.rotate)) out.rotate = e.rotate
  if (Array.isArray(e.colorKeys)) {
    const keys = e.colorKeys.filter(isColorKey)
    if (keys.length) out.colorKeys = keys.map((k) => ({ color: k.color, tolerance: k.tolerance }))
  }
  if (e.sized === true) out.sized = true
  return out
}

/** Пометка/мёрж `image` в `extra`, не трогая соседние поля `x-cnv`. */
export function withImageEdit(
  extra: Record<string, unknown>,
  patch: Partial<ImageEdit>
): Record<string, unknown> {
  const own = extra[KEY]
  const base = own && typeof own === 'object' ? (own as Record<string, unknown>) : {}
  const img = base.image && typeof base.image === 'object' ? (base.image as Record<string, unknown>) : {}
  return { ...extra, [KEY]: { ...base, image: { ...img, ...patch } } }
}

/** Есть ли вообще нетривиальные правки (нужно, чтобы отключить авто-пропорцию). */
export function hasEdits(edit: ImageEdit | null): boolean {
  if (!edit) return false
  return Boolean(edit.crop) || edit.rotate !== undefined || (edit.colorKeys?.length ?? 0) > 0 || Boolean(edit.sized)
}

/** Угол в диапазон [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Снап угла к шагу (по умолчанию 45°) — для модификатора точности. */
export function snapAngle(deg: number, step = 45): number {
  return Math.round(deg / step) * step
}

/** Axis-aligned bounding box рамки, повёрнутой на `deg` вокруг своего центра. */
export function rotatedAABB(rect: Rect, deg: number): Rect {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const hw = rect.width / 2
  const hh = rect.height / 2
  const corners: Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ].map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos }))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/** Точка внутри рамки, повёрнутой на `deg` вокруг центра (хит-тест повёрнутой картинки). */
export function pointInRotatedRect(p: Point, rect: Rect, deg: number): boolean {
  const rad = (-deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  // Переводим точку в локальную (неповёрнутую) систему рамки.
  const dx = p.x - cx
  const dy = p.y - cy
  const lx = dx * cos - dy * sin + rect.width / 2
  const ly = dx * sin + dy * cos + rect.height / 2
  return lx >= 0 && lx <= rect.width && ly >= 0 && ly <= rect.height
}

/** CSS-раскладка `<img>` (в процентах) для показа суб-прямоугольника кропа во всю обёртку. */
export interface CropStyle {
  width: number
  height: number
  left: number
  top: number
}

export function cropStyle(crop: CropRect): CropStyle {
  return {
    width: (100 / crop.w),
    height: (100 / crop.h),
    left: -(crop.x / crop.w) * 100 + 0,
    top: -(crop.y / crop.h) * 100 + 0
  }
}

/** Пропорция (ширина/высота) с учётом кропа — для переученной авто-подгонки. */
export function cropAspect(naturalW: number, naturalH: number, crop?: CropRect): number {
  const w = naturalW * (crop?.w ?? 1)
  const h = naturalH * (crop?.h ?? 1)
  return h === 0 ? 1 : w / h
}
