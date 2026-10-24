import { describe, expect, it } from 'vitest'
import { matchName, notFoundMessage } from '@core/name-match'

const people = ['Бесстрашная Прасковья', 'Шустрый Олег', 'Хитрый Фома', 'Хитрая Варвара', 'Тихий Олег'].map(
  (name, i) => ({ id: `n${i}`, name })
)
const m = (ref: string): ReturnType<typeof matchName<(typeof people)[number]>> =>
  matchName(people, ref, (p) => p.name)

describe('поиск по имени', () => {
  it('полное имя — без учёта регистра и ё', () => {
    expect(m('бесстрашная прасковья').hit?.id).toBe('n0')
  })

  it('одно слово имени — если такое одно', () => {
    expect(m('Прасковья').hit?.id).toBe('n0')
    expect(m('Фома').hit?.id).toBe('n2')
  })

  it('начало слова', () => {
    expect(m('Прасков').hit?.id).toBe('n0')
  })

  it('несколько подходят — неоднозначно, со списком', () => {
    const r = m('Олег')
    expect(r.hit).toBeUndefined()
    expect(r.ambiguous.map((p) => p.id)).toEqual(['n1', 'n4'])
    expect(notFoundMessage('агента', 'Олег', r, (p) => p.name)).toContain('Шустрый Олег, Тихий Олег')
  })

  it('опечатка — подсказка «может, ты про»', () => {
    const r = m('Прасковя')
    expect(r.hit).toBeUndefined()
    expect(r.similar.map((p) => p.id)).toEqual(['n0'])
    expect(notFoundMessage('агента', 'Прасковя', r, (p) => p.name)).toBe(
      'нет агента «Прасковя». Может, ты про Бесстрашная Прасковья?'
    )
  })

  it('совсем мимо — просто «нет»', () => {
    const r = m('Зигмунд')
    expect(notFoundMessage('агента', 'Зигмунд', r, (p) => p.name)).toBe('нет агента «Зигмунд»')
  })
})
