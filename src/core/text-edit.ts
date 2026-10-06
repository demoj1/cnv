import type { DocNode } from './document'

/**
 * Оформление текстовой карточки: шрифт и его размер. Живёт в `x-cnv.text` ноды, как и
 * остальное наше состояние вне JSON Canvas — в Obsidian карточка покажется обычной, а поля
 * переживут round-trip.
 */
export interface TextEdit {
  /** Размер шрифта в px. Нет значения — берём дефолт из настроек. */
  fontSize?: number
  /** Ключ пресета шрифта (см. FONT_PRESETS). Нет значения — системный (наследуется). */
  fontFamily?: string
}

const KEY = 'x-cnv'

/** Пресеты шрифта: ключ хранится в ноде, stack подставляется в CSS. `undefined` — системный. */
export const FONT_PRESETS: ReadonlyArray<{ key: string; label: string; stack?: string }> = [
  { key: 'system', label: 'Система' },
  { key: 'sans', label: 'Sans', stack: 'ui-sans-serif, system-ui, sans-serif' },
  { key: 'serif', label: 'Serif', stack: 'ui-serif, Georgia, Cambria, serif' },
  { key: 'mono', label: 'Mono', stack: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
]

/** Быстрые пресеты размера для панели. */
export const SIZE_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'S', value: 16 },
  { label: 'M', value: 22 },
  { label: 'L', value: 30 },
  { label: 'XL', value: 43 }
]

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 72

/** Ключ пресета → CSS font-family. Неизвестный ключ или системный → `undefined` (наследуем). */
export function resolveFontFamily(key: string | undefined): string | undefined {
  return FONT_PRESETS.find((p) => p.key === key)?.stack
}

/** Размер в допустимые границы. */
export function clampFontSize(px: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, Math.round(px)))
}

/** Оформление карточки, или null — если это не текст либо правок нет. */
export function textEdit(node: DocNode): TextEdit | null {
  if (node.type !== 'text') return null
  const own = node.extra[KEY]
  if (!own || typeof own !== 'object') return null
  const raw = (own as Record<string, unknown>).text
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const out: TextEdit = {}
  if (typeof e.fontSize === 'number' && Number.isFinite(e.fontSize)) out.fontSize = e.fontSize
  if (typeof e.fontFamily === 'string') out.fontFamily = e.fontFamily
  return out
}

/** Мёрж `text` в `extra`, не трогая соседние поля `x-cnv`. */
export function withTextEdit(
  extra: Record<string, unknown>,
  patch: Partial<TextEdit>
): Record<string, unknown> {
  const own = extra[KEY]
  const base = own && typeof own === 'object' ? (own as Record<string, unknown>) : {}
  const text = base.text && typeof base.text === 'object' ? (base.text as Record<string, unknown>) : {}
  return { ...extra, [KEY]: { ...base, text: { ...text, ...patch } } }
}
