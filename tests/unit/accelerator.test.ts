import { describe, expect, it } from 'vitest'
import { matchesAccelerator, parseAccelerator } from '@core/accelerator'

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    code: '',
    ...init
  }) as KeyboardEvent

describe('парсер акселераторов', () => {
  it('CmdOrCtrl зависит от платформы', () => {
    expect(parseAccelerator('CmdOrCtrl+S', false)).toMatchObject({ ctrl: true, meta: false, key: 's' })
    expect(parseAccelerator('CmdOrCtrl+S', true)).toMatchObject({ ctrl: false, meta: true, key: 's' })
  })

  it('разбирает модификаторы', () => {
    expect(parseAccelerator('Ctrl+Shift+Alt+K', false)).toEqual({
      ctrl: true,
      meta: false,
      shift: true,
      alt: true,
      key: 'k'
    })
  })
})

describe('сопоставление с событием', () => {
  it('Ctrl+S', () => {
    const a = parseAccelerator('CmdOrCtrl+S', false)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, key: 'S', code: 'KeyS' }))).toBe(true)
    expect(matchesAccelerator(a, ev({ key: 's', code: 'KeyS' }))).toBe(false)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, shiftKey: true, key: 'S', code: 'KeyS' }))).toBe(false)
  })

  it('Shift+1 ловится по коду клавиши, а не по символу "!"', () => {
    const a = parseAccelerator('Shift+1', false)
    expect(matchesAccelerator(a, ev({ shiftKey: true, key: '!', code: 'Digit1' }))).toBe(true)
    expect(matchesAccelerator(a, ev({ shiftKey: true, key: '!', code: 'Digit2' }))).toBe(false)
  })

  it('Ctrl+= срабатывает и на "+"', () => {
    const a = parseAccelerator('CmdOrCtrl+=', false)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, key: '=', code: 'Equal' }))).toBe(true)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, key: '+', code: 'Equal' }))).toBe(true)
  })

  it('Ctrl+0 не путается с Ctrl+Shift+0', () => {
    const a = parseAccelerator('CmdOrCtrl+0', false)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, key: '0', code: 'Digit0' }))).toBe(true)
    expect(matchesAccelerator(a, ev({ ctrlKey: true, shiftKey: true, key: ')', code: 'Digit0' }))).toBe(false)
  })

  it('Escape', () => {
    const a = parseAccelerator('Escape', false)
    expect(matchesAccelerator(a, ev({ key: 'Escape', code: 'Escape' }))).toBe(true)
  })
})

describe('раскладка не ломает хоткеи (матч по физкоду)', () => {
  // На русской раскладке та же клавиша даёт кириллицу в event.key, но event.code тот же.
  const ru = (code: string, key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ code, key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent

  it('Ctrl+T ловится, когда key="е" (кириллица), code="KeyT"', () => {
    const p = parseAccelerator('CmdOrCtrl+T', false)
    expect(matchesAccelerator(p, ru('KeyT', 'е', { ctrlKey: true }))).toBe(true)
  })

  it('Ctrl+Shift+Z ловится с кириллическим key и учитывает Shift', () => {
    const p = parseAccelerator('CmdOrCtrl+Shift+Z', false)
    expect(matchesAccelerator(p, ru('KeyZ', 'я', { ctrlKey: true, shiftKey: true }))).toBe(true)
    // без Shift это уже другой хоткей — не должен совпасть
    expect(matchesAccelerator(p, ru('KeyZ', 'я', { ctrlKey: true }))).toBe(false)
  })

  it('Ctrl+] ловится, когда физический код BracketRight даёт "ъ"', () => {
    const p = parseAccelerator('CmdOrCtrl+]', false)
    expect(matchesAccelerator(p, ru('BracketRight', 'ъ', { ctrlKey: true }))).toBe(true)
  })

  it('Ctrl+, ловится, когда Comma даёт "б"', () => {
    const p = parseAccelerator('CmdOrCtrl+,', false)
    expect(matchesAccelerator(p, ru('Comma', 'б', { ctrlKey: true }))).toBe(true)
  })

  it('латинская раскладка по-прежнему работает', () => {
    expect(matchesAccelerator(parseAccelerator('CmdOrCtrl+T', false), ru('KeyT', 't', { ctrlKey: true }))).toBe(true)
    expect(matchesAccelerator(parseAccelerator('Shift+1', false), ru('Digit1', '!', { shiftKey: true }))).toBe(true)
  })
})
