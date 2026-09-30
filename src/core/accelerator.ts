export interface ParsedAccelerator {
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  key: string
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  plus: '=',
  numadd: '+',
  space: ' '
}

export function parseAccelerator(accelerator: string, isMac: boolean): ParsedAccelerator {
  const parts = accelerator.split('+').map((p) => p.trim())
  const result: ParsedAccelerator = { ctrl: false, meta: false, shift: false, alt: false, key: '' }
  for (const raw of parts) {
    const p = raw.toLowerCase()
    switch (p) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        if (isMac) result.meta = true
        else result.ctrl = true
        break
      case 'cmd':
      case 'command':
      case 'super':
        result.meta = true
        break
      case 'ctrl':
      case 'control':
        result.ctrl = true
        break
      case 'shift':
        result.shift = true
        break
      case 'alt':
      case 'option':
        result.alt = true
        break
      default:
        result.key = KEY_ALIASES[p] ?? p
    }
  }
  return result
}

/**
 * Физический код клавиши для символа акселератора. Именно он не зависит от раскладки: на
 * кириллице `event.key` для той же клавиши даёт кириллицу (`т` вместо `t`, `ъ` вместо `]`),
 * и матч по символу разваливается. null — для именованных клавиш (Escape, F1…), которые
 * `event.key` отдаёт одинаково при любой раскладке.
 */
const PUNCT_CODE: Record<string, string> = {
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'quote',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  '`': 'backquote'
}

function physicalCode(target: string): string | null {
  if (/^[a-z]$/.test(target)) return `key${target}`
  if (/^[0-9]$/.test(target)) return `digit${target}`
  return PUNCT_CODE[target] ?? null
}

export function matchesAccelerator(parsed: ParsedAccelerator, event: KeyboardEvent): boolean {
  if (parsed.ctrl !== event.ctrlKey) return false
  if (parsed.meta !== event.metaKey) return false
  if (parsed.alt !== event.altKey) return false

  const key = event.key.toLowerCase()
  const code = event.code.toLowerCase()
  const target = parsed.key
  const wantCode = physicalCode(target)

  // Одиночная клавиша сверяется по физическому коду — тогда хоткей работает на любой
  // раскладке. Символ оставлен запасным вариантом (и для `=`/`-`, которые под Shift дают
  // `+`/`_`). Shift для таких хоткеев проверяем тут же: Shift+1 приходит с key="!".
  if (wantCode) {
    const hit =
      code === wantCode ||
      key === target ||
      (target === '=' && key === '+') ||
      (target === '-' && key === '_')
    if (!hit) return false
    return parsed.shift === event.shiftKey
  }

  if (parsed.shift !== event.shiftKey) return false
  return key === target
}
