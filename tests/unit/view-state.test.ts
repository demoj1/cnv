import { describe, expect, it } from 'vitest'
import { APP_DATA_KEY } from '@shared/app'
import type { CanvasDoc, DocNode } from '@core/document'
import {
  EMPTY_VIEW_STATE,
  nodeViewState,
  pruneViewState,
  readViewState,
  withNodeViewState,
  writeViewState
} from '@core/view-state'

const node = (id: string): DocNode => ({
  id,
  type: 'text',
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  extra: {}
})

const doc = (nodes: DocNode[] = [], extra: Record<string, unknown> = {}): CanvasDoc => ({
  nodes,
  edges: [],
  extra
})

describe('состояние вида внутри документа', () => {
  it('на чистом документе пусто', () => {
    expect(readViewState(doc())).toBe(EMPTY_VIEW_STATE)
  })

  it('пишется и читается из x-cnv', () => {
    const next = writeViewState(doc(), { camera: { x: 10, y: -20, zoom: 1.5 } })
    expect(next.extra[APP_DATA_KEY]).toEqual({ camera: { x: 10, y: -20, zoom: 1.5 } })
    expect(readViewState(next).camera?.zoom).toBe(1.5)
  })

  it('запись того же состояния не пересоздаёт документ', () => {
    const base = writeViewState(doc(), { camera: { x: 1, y: 2, zoom: 1 } })
    expect(writeViewState(base, { camera: { x: 1, y: 2, zoom: 1 } })).toBe(base)
  })

  it('не затирает чужие корневые поля', () => {
    const next = writeViewState(doc([], { сторонний: 'ключ' }), { camera: { x: 0, y: 0, zoom: 1 } })
    expect(next.extra['сторонний']).toBe('ключ')
  })

  it('мусор в x-cnv не ломает чтение', () => {
    expect(readViewState(doc([], { [APP_DATA_KEY]: 'строка' }))).toBe(EMPTY_VIEW_STATE)
    expect(readViewState(doc([], { [APP_DATA_KEY]: null }))).toBe(EMPTY_VIEW_STATE)
  })

  it('состояние ноды добавляется и читается', () => {
    const state = withNodeViewState(EMPTY_VIEW_STATE, 'n1', { pdfPage: 7 })
    expect(nodeViewState(state, 'n1').pdfPage).toBe(7)
    expect(nodeViewState(state, 'нет')).toEqual({})
    expect(withNodeViewState(state, 'n1', { webZoom: 1.2 }).nodes?.n1).toEqual({ pdfPage: 7, webZoom: 1.2 })
  })

  it('исчезнувшие ноды выпадают из состояния', () => {
    const state = withNodeViewState(withNodeViewState(EMPTY_VIEW_STATE, 'жив', { pdfPage: 1 }), 'мёртв', {
      pdfPage: 2
    })
    const pruned = pruneViewState(state, doc([node('жив')]))
    expect(Object.keys(pruned.nodes ?? {})).toEqual(['жив'])
    expect(pruneViewState(pruned, doc([node('жив')]))).toBe(pruned)
  })
})
