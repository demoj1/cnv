import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CanvasParseError, parseCanvas, serializeCanvas } from '@core/serialization'
import type { CanvasDoc } from '@core/document'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8')

const obsidian = fixture('obsidian-authored.canvas')
const unknownFields = fixture('unknown-fields.canvas')

describe('чтение канваса Obsidian', () => {
  const doc = parseCanvas(obsidian)

  it('все четыре типа нод и два ребра', () => {
    expect(doc.nodes.map((n) => n.type)).toEqual(['group', 'text', 'file', 'link'])
    expect(doc.edges).toHaveLength(2)
  })

  it('типизированные поля нод', () => {
    const [group, text, file, link] = doc.nodes
    expect(group).toMatchObject({ type: 'group', label: 'Группа', x: -440, y: 160, width: 800, height: 320 })
    expect(text).toMatchObject({ type: 'text', color: '4' })
    expect(text?.type === 'text' && text.text).toContain('# Заголовок')
    expect(file).toMatchObject({ type: 'file', file: 'note.md' })
    expect(link).toMatchObject({ type: 'link', url: 'https://jsoncanvas.org' })
  })

  it('поля рёбер, включая color, label и toEnd', () => {
    expect(doc.edges[0]).toMatchObject({
      id: 'e0000000000000a1',
      fromNode: 'a2fa399bc2d7bd9f',
      fromSide: 'right',
      toNode: 'f78478d5f7be486f',
      toSide: 'left',
      color: '2',
      label: 'ссылается'
    })
    expect(doc.edges[1]).toMatchObject({ toEnd: 'none' })
    expect(doc.edges[1]?.label).toBeUndefined()
  })

  it('extra пуст, когда чужих полей нет', () => {
    expect(doc.extra).toEqual({})
    for (const n of doc.nodes) expect(n.extra).toEqual({})
    for (const e of doc.edges) expect(e.extra).toEqual({})
  })
})

describe('round-trip байт в байт', () => {
  it('файл, созданный Obsidian', () => {
    expect(serializeCanvas(parseCanvas(obsidian))).toBe(obsidian)
  })

  it('файл с мусорными полями', () => {
    expect(serializeCanvas(parseCanvas(unknownFields))).toBe(unknownFields)
  })
})

describe('неизвестные поля', () => {
  const doc = parseCanvas(unknownFields)

  it('уезжают в extra на ноде, ребре и в корне', () => {
    expect(doc.nodes[0]?.extra).toEqual({
      'x-cnv': { page: 7, note: 'не трогай' },
      totallyUnknownField: [1, 2, 3]
    })
    expect(doc.nodes[1]?.extra).toEqual({ groupJunk: true })
    expect(doc.edges[0]?.extra).toEqual({ customEdgeField: 'сохранись' })
    expect(doc.extra).toEqual({ rootLevelJunk: { hello: 'world' }, schemaVersion: 3 })
  })

  it('extra не содержит известных ключей', () => {
    const node = doc.nodes[0]
    expect(node?.extra).not.toHaveProperty('id')
    expect(node?.extra).not.toHaveProperty('text')
    expect(doc.extra).not.toHaveProperty('nodes')
  })

  it('известное поле побеждает одноимённое в extra', () => {
    const handmade: CanvasDoc = {
      nodes: [
        {
          id: 'n1',
          type: 'text',
          text: 'привет',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          color: '1',
          extra: { color: '9' }
        }
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1', label: 'да', extra: { label: 'нет' } }],
      extra: { nodes: 'подделка' }
    }
    const out = serializeCanvas(handmade)
    expect(out).toContain('"color":"1"')
    expect(out).not.toContain('"color":"9"')
    expect(out).toContain('"label":"да"')
    expect(out).not.toContain('"label":"нет"')
    expect(out).not.toContain('подделка')
  })
})

describe('координаты', () => {
  const text = '{"nodes":[{"id":"n1","type":"text","text":"a","x":10.6,"y":-3.2,"width":99.5,"height":0.4}]}'

  it('при чтении берутся как есть', () => {
    expect(parseCanvas(text).nodes[0]).toMatchObject({ x: 10.6, y: -3.2, width: 99.5, height: 0.4 })
  })

  it('при записи округляются', () => {
    expect(serializeCanvas(parseCanvas(text))).toContain('"x":11,"y":-3,"width":100,"height":0')
  })
})

describe('пустые документы', () => {
  const empty = '{\n\t"nodes":[],\n\t"edges":[]\n}'

  it('пустой файл', () => {
    expect(parseCanvas('')).toEqual({ nodes: [], edges: [], extra: {} })
    expect(parseCanvas('   \n')).toEqual({ nodes: [], edges: [], extra: {} })
  })

  it('{} — валидный пустой документ', () => {
    expect(parseCanvas('{}')).toEqual({ nodes: [], edges: [], extra: {} })
  })

  it('отсутствующий edges', () => {
    expect(parseCanvas('{"nodes":[]}').edges).toEqual([])
  })

  it('пустые массивы пишутся в одну строку', () => {
    expect(serializeCanvas(parseCanvas('{}'))).toBe(empty)
  })
})

describe('ошибки чтения', () => {
  const fails = (text: string) => () => parseCanvas(text)

  it('не JSON', () => {
    expect(fails('{это не json')).toThrow(CanvasParseError)
    expect(fails('{это не json')).toThrow(/корректным JSON/)
  })

  it('корень не объект', () => {
    expect(fails('[]')).toThrow(/должен быть объектом/)
    expect(fails('42')).toThrow(CanvasParseError)
  })

  it('nodes не массив', () => {
    expect(fails('{"nodes":{}}')).toThrow(/"nodes" должно быть массивом/)
    expect(fails('{"nodes":null}')).toThrow(/"nodes" должно быть массивом/)
    expect(fails('{"edges":"нет"}')).toThrow(/"edges" должно быть массивом/)
  })

  it('нода без id', () => {
    expect(fails('{"nodes":[{"type":"text","text":"a"}]}')).toThrow(/"id"/)
  })

  it('неизвестный тип ноды', () => {
    expect(fails('{"nodes":[{"id":"n1","type":"wat"}]}')).toThrow(/неизвестный тип "wat"/)
  })

  it('ребро без id', () => {
    expect(fails('{"edges":[{"fromNode":"a","toNode":"b"}]}')).toThrow(/"id"/)
  })
})
