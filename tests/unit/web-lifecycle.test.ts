import { describe, expect, it } from 'vitest'
import {
  chooseLiveNodes,
  snapshotKeyFor,
  type LifecycleParams,
  type WebNodeRuntime
} from '@core/web-lifecycle'

const NOW = 1_000_000

const node = (id: string, patch: Partial<WebNodeRuntime> = {}): WebNodeRuntime => ({
  id,
  visible: true,
  lastVisibleAt: NOW,
  live: false,
  ...patch
})

const params = (patch: Partial<LifecycleParams> = {}): LifecycleParams => ({
  zoom: 1,
  zoomThreshold: 0.35,
  liveLimit: 6,
  offscreenUnloadMs: 20000,
  activeId: null,
  now: NOW,
  ...patch
})

describe('выбор живых веб-нод', () => {
  it('все видимые оживают, пока влезают в лимит', () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id))
    expect([...chooseLiveNodes(nodes, params())].sort()).toEqual(['a', 'b', 'c'])
  })

  it('сверх лимита остаются самые свежие', () => {
    const nodes = [
      node('старая', { lastVisibleAt: NOW - 5000 }),
      node('свежая', { lastVisibleAt: NOW }),
      node('средняя', { lastVisibleAt: NOW - 1000 })
    ]
    expect([...chooseLiveNodes(nodes, params({ liveLimit: 2 }))].sort()).toEqual(['свежая', 'средняя'])
  })

  it('активная нода не вытесняется даже сверх лимита', () => {
    const nodes = [
      node('активная', { visible: false, lastVisibleAt: NOW - 1e9 }),
      node('a'),
      node('b'),
      node('c')
    ]
    const live = chooseLiveNodes(nodes, params({ liveLimit: 1, activeId: 'активная' }))
    expect(live.has('активная')).toBe(true)
    expect(live.size).toBe(1)
  })

  it('ниже порога zoom живой остаётся только активная', () => {
    const nodes = [node('a'), node('b'), node('активная')]
    expect([...chooseLiveNodes(nodes, params({ zoom: 0.2, activeId: 'активная' }))]).toEqual(['активная'])
    expect(chooseLiveNodes(nodes, params({ zoom: 0.2 })).size).toBe(0)
  })

  it('ушедшая за экран живая держится N мс, потом выгружается', () => {
    const recent = [node('a', { visible: false, live: true, lastVisibleAt: NOW - 5000 })]
    expect(chooseLiveNodes(recent, params()).has('a')).toBe(true)

    const stale = [node('a', { visible: false, live: true, lastVisibleAt: NOW - 25000 })]
    expect(chooseLiveNodes(stale, params()).has('a')).toBe(false)
  })

  it('невидимая и неживая нода сама не оживает', () => {
    const nodes = [node('a', { visible: false, live: false, lastVisibleAt: NOW })]
    expect(chooseLiveNodes(nodes, params()).size).toBe(0)
  })

  it('видимые важнее недавно ушедших за экран', () => {
    const nodes = [
      node('ушла', { visible: false, live: true, lastVisibleAt: NOW - 100 }),
      node('видна', { lastVisibleAt: NOW - 9000 })
    ]
    expect([...chooseLiveNodes(nodes, params({ liveLimit: 1 }))]).toEqual(['видна'])
  })

  it('активная, которой нет в списке, не попадает в результат', () => {
    expect(chooseLiveNodes([node('a')], params({ activeId: 'призрак' })).has('призрак')).toBe(false)
  })

  it('выбор устойчив: одинаковые ноды сортируются по id', () => {
    const nodes = [node('b'), node('a')]
    expect([...chooseLiveNodes(nodes, params({ liveLimit: 1 }))]).toEqual(['a'])
  })
})

describe('нули выключают выгрузку', () => {
  const never = (patch: Partial<LifecycleParams> = {}): LifecycleParams =>
    params({ liveLimit: 0, zoomThreshold: 0, offscreenUnloadMs: 0, ...patch })

  it('без лимита живут все видимые', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`))
    expect(chooseLiveNodes(nodes, never()).size).toBe(30)
  })

  it('нулевой порог zoom не выгружает даже на обзоре всего холста', () => {
    const nodes = [node('a'), node('b')]
    expect(chooseLiveNodes(nodes, never({ zoom: 0.01 })).size).toBe(2)
  })

  it('ушедшая за экран живая остаётся живой сколько угодно', () => {
    const nodes = [node('a', { visible: false, live: true, lastVisibleAt: NOW - 86_400_000 })]
    expect(chooseLiveNodes(nodes, never()).has('a')).toBe(true)
  })

  it('ни разу не показанная гостя всё равно не поднимает', () => {
    const nodes = [node('a', { visible: false, live: false, lastVisibleAt: 0 })]
    expect(chooseLiveNodes(nodes, never()).size).toBe(0)
  })

  it('ненулевой лимит по-прежнему работает', () => {
    const nodes = [node('a'), node('b'), node('c')]
    expect(chooseLiveNodes(nodes, never({ liveLimit: 2 })).size).toBe(2)
  })
})

describe('ключ снимка', () => {
  it('зависит и от ноды, и от адреса', () => {
    expect(snapshotKeyFor('n1', 'https://a')).not.toBe(snapshotKeyFor('n1', 'https://b'))
    expect(snapshotKeyFor('n1', 'https://a')).not.toBe(snapshotKeyFor('n2', 'https://a'))
  })
})
