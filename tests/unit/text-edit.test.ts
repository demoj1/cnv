import { describe, expect, it } from 'vitest'
import type { DocNode } from '@core/document'
import {
  clampFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resolveFontFamily,
  textEdit,
  withTextEdit
} from '@core/text-edit'

const card = (extra: Record<string, unknown> = {}): DocNode => ({
  id: 'n1',
  type: 'text',
  text: 'hi',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  extra
})

describe('чтение x-cnv.text', () => {
  it('у чистой карточки правок нет', () => {
    expect(textEdit(card())).toBeNull()
  })

  it('читает размер и шрифт', () => {
    const e = textEdit(card({ 'x-cnv': { text: { fontSize: 22, fontFamily: 'serif' } } }))
    expect(e).toEqual({ fontSize: 22, fontFamily: 'serif' })
  })

  it('не-текст (картинка) правок не имеет', () => {
    const img: DocNode = { ...card(), type: 'file', file: 'a.png' } as unknown as DocNode
    expect(textEdit(img)).toBeNull()
  })

  it('мусор в полях отбрасывается, а не роняет', () => {
    const e = textEdit(card({ 'x-cnv': { text: { fontSize: 'big', fontFamily: 5 } } }))
    expect(e).toEqual({})
  })
})

describe('запись x-cnv.text поверх чужих полей', () => {
  it('добавляет text, не трогая соседей в x-cnv', () => {
    const extra = withTextEdit({ 'x-cnv': { image: { rotate: 90 } } }, { fontSize: 16 })
    expect(extra['x-cnv']).toEqual({ image: { rotate: 90 }, text: { fontSize: 16 } })
  })

  it('мёржит в уже существующий text', () => {
    const extra = withTextEdit({ 'x-cnv': { text: { fontSize: 16 } } }, { fontFamily: 'mono' })
    expect((extra['x-cnv'] as Record<string, unknown>).text).toEqual({ fontSize: 16, fontFamily: 'mono' })
  })
})

describe('пресеты шрифта', () => {
  it('системный/неизвестный → без стека (наследуем)', () => {
    expect(resolveFontFamily('system')).toBeUndefined()
    expect(resolveFontFamily(undefined)).toBeUndefined()
    expect(resolveFontFamily('wat')).toBeUndefined()
  })

  it('известный ключ → css-стек', () => {
    expect(resolveFontFamily('mono')).toContain('monospace')
    expect(resolveFontFamily('serif')).toContain('serif')
  })
})

describe('границы размера', () => {
  it('зажимает и округляет', () => {
    expect(clampFontSize(2)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(16.6)).toBe(17)
  })
})
