import { describe, expect, it } from 'vitest'
import { applyColorMask, hexToRgb, maskCacheKey, matchesKey, rgbToHex } from '@core/color-mask'

describe('hex ↔ rgb', () => {
  it('разбирает #rrggbb и #rgb', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255])
    expect(hexToRgb('#000000')).toEqual([0, 0, 0])
    expect(hexToRgb('#f00')).toEqual([255, 0, 0])
    expect(hexToRgb('#336699')).toEqual([0x33, 0x66, 0x99])
  })
  it('мусор → чёрный', () => {
    expect(hexToRgb('нет')).toEqual([0, 0, 0])
  })
  it('rgbToHex — обратка', () => {
    expect(rgbToHex([255, 0, 128])).toBe('#ff0080')
  })
})

describe('совпадение с ключом', () => {
  it('точное совпадение при нулевом допуске', () => {
    expect(matchesKey(255, 255, 255, { color: '#ffffff', tolerance: 0 })).toBe(true)
    expect(matchesKey(254, 255, 255, { color: '#ffffff', tolerance: 0 })).toBe(false)
  })
  it('допуск расширяет захват', () => {
    expect(matchesKey(240, 240, 240, { color: '#ffffff', tolerance: 0.1 })).toBe(true)
    expect(matchesKey(0, 0, 0, { color: '#ffffff', tolerance: 0.1 })).toBe(false)
  })
})

describe('применение маски', () => {
  it('выбивает альфу у белых, не трогает остальное', () => {
    // 2 пикселя: белый и красный
    const data = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255])
    applyColorMask(data, [{ color: '#ffffff', tolerance: 0.02 }])
    expect(data[3]).toBe(0) // белый прозрачный
    expect(data[7]).toBe(255) // красный цел
  })
  it('пустой список ключей ничего не меняет', () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255])
    applyColorMask(data, [])
    expect(data[3]).toBe(255)
  })
})

describe('ключ кэша', () => {
  it('зависит от файла и параметров', () => {
    const a = maskCacheKey('a.png', [{ color: '#fff', tolerance: 0.1 }])
    const b = maskCacheKey('a.png', [{ color: '#fff', tolerance: 0.2 }])
    expect(a).not.toBe(b)
  })
})
