import { describe, expect, it } from 'vitest'
import type { DocNode } from '@core/document'
import {
  cropAspect,
  cropStyle,
  hasEdits,
  imageEdit,
  normalizeAngle,
  pointInRotatedRect,
  rotatedAABB,
  snapAngle,
  withImageEdit
} from '@core/image-edit'

const img = (extra: Record<string, unknown> = {}): DocNode => ({
  id: 'n1',
  type: 'file',
  file: 'attachments/p.png',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  extra
})

describe('чтение x-cnv.image', () => {
  it('у чистой картинки правок нет', () => {
    expect(imageEdit(img())).toBeNull()
    expect(hasEdits(imageEdit(img()))).toBe(false)
  })

  it('читает поворот, кроп, цвета и флаг sized', () => {
    const e = imageEdit(
      img({
        'x-cnv': {
          image: {
            rotate: 30,
            crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
            colorKeys: [{ color: '#ffffff', tolerance: 0.2 }],
            sized: true
          }
        }
      })
    )
    expect(e).toEqual({
      rotate: 30,
      crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
      colorKeys: [{ color: '#ffffff', tolerance: 0.2 }],
      sized: true
    })
    expect(hasEdits(e)).toBe(true)
  })

  it('не-картинка (текст) правок не имеет', () => {
    const text: DocNode = { ...img(), type: 'text', text: 'hi' } as DocNode
    expect(imageEdit(text)).toBeNull()
  })

  it('мусор в полях отбрасывается, а не роняет', () => {
    const e = imageEdit(img({ 'x-cnv': { image: { rotate: 'nope', crop: 5, colorKeys: 'x' } } }))
    expect(e).toEqual({})
    expect(hasEdits(e)).toBe(false)
  })
})

describe('запись x-cnv.image поверх чужих полей', () => {
  it('добавляет image, не трогая соседей в x-cnv', () => {
    const extra = withImageEdit({ 'x-cnv': { camera: { zoom: 1 } } }, { rotate: 90 })
    expect(extra['x-cnv']).toEqual({ camera: { zoom: 1 }, image: { rotate: 90 } })
  })

  it('мёржит в уже существующий image', () => {
    const extra = withImageEdit({ 'x-cnv': { image: { rotate: 90 } } }, { sized: true })
    expect((extra['x-cnv'] as Record<string, unknown>).image).toEqual({ rotate: 90, sized: true })
  })
})

describe('углы', () => {
  it('нормализует в 0..360', () => {
    expect(normalizeAngle(-90)).toBe(270)
    expect(normalizeAngle(450)).toBe(90)
    expect(normalizeAngle(360)).toBe(0)
  })

  it('снапит к 45°', () => {
    expect(snapAngle(43)).toBe(45)
    expect(snapAngle(20)).toBe(0)
    expect(snapAngle(67)).toBe(45)
    expect(snapAngle(70)).toBe(90)
  })
})

describe('AABB повёрнутой рамки', () => {
  it('без поворота совпадает с самой рамкой', () => {
    expect(rotatedAABB({ x: 0, y: 0, width: 200, height: 100 }, 0)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100
    })
  })

  it('поворот на 90° меняет местами ширину и высоту вокруг центра', () => {
    const b = rotatedAABB({ x: 0, y: 0, width: 200, height: 100 }, 90)
    expect(b.width).toBeCloseTo(100, 6)
    expect(b.height).toBeCloseTo(200, 6)
    // центр сохраняется: (100,50)
    expect(b.x + b.width / 2).toBeCloseTo(100, 6)
    expect(b.y + b.height / 2).toBeCloseTo(50, 6)
  })

  it('поворот на 45° расширяет коробку', () => {
    const b = rotatedAABB({ x: 0, y: 0, width: 100, height: 100 }, 45)
    expect(b.width).toBeCloseTo(141.42, 1)
    expect(b.height).toBeCloseTo(141.42, 1)
  })
})

describe('точка внутри повёрнутой рамки', () => {
  const rect = { x: 0, y: 0, width: 200, height: 100 }
  it('центр внутри при любом угле', () => {
    expect(pointInRotatedRect({ x: 100, y: 50 }, rect, 37)).toBe(true)
  })
  it('угол, вылезший за поворотом, снаружи исходной рамки, но внутри повёрнутой', () => {
    // точка чуть выше середины верхнего края; при 90° рамка узкая и высокая
    expect(pointInRotatedRect({ x: 100, y: 5 }, rect, 90)).toBe(true)
    // далеко сбоку — снаружи
    expect(pointInRotatedRect({ x: 195, y: 50 }, rect, 90)).toBe(false)
  })
})

describe('css-раскладка кропнутой картинки', () => {
  it('полный кадр — картинка 100% без сдвига', () => {
    expect(cropStyle({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ width: 100, height: 100, left: 0, top: 0 })
  })
  it('левая половина по ширине — картинка вдвое шире, без сдвига', () => {
    expect(cropStyle({ x: 0, y: 0, w: 0.5, h: 1 })).toEqual({ width: 200, height: 100, left: 0, top: 0 })
  })
  it('правая половина — картинка вдвое шире, сдвинута влево на свою ширину', () => {
    expect(cropStyle({ x: 0.5, y: 0, w: 0.5, h: 1 })).toEqual({ width: 200, height: 100, left: -100, top: 0 })
  })
  it('центральный квадрат — увеличение и сдвиг по обеим осям', () => {
    expect(cropStyle({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 })).toEqual({
      width: 200,
      height: 200,
      left: -50,
      top: -50
    })
  })
})

describe('эффективная пропорция после кропа', () => {
  it('без кропа — пропорция исходника', () => {
    expect(cropAspect(400, 300)).toBeCloseTo(4 / 3, 6)
  })
  it('кроп меняет пропорцию', () => {
    // берём половину ширины, всю высоту → 200x300
    expect(cropAspect(400, 300, { x: 0, y: 0, w: 0.5, h: 1 })).toBeCloseTo(200 / 300, 6)
  })
})
