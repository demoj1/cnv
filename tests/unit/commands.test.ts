import { describe, expect, it } from 'vitest'
import {
  APP_MENU,
  CANVAS_CONTEXT_MENU,
  COMMANDS,
  COMMAND_BY_ID,
  MENU_SECTIONS,
  NODE_CONTEXT_MENU,
  SECTION_LABELS,
  menuCommandIds
} from '@shared/commands'
import { parseAccelerator } from '@core/accelerator'

describe('карта команд', () => {
  it('идентификаторы уникальны', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('акселераторы не конфликтуют', () => {
    const seen = new Map<string, string>()
    for (const c of COMMANDS) {
      if (!c.accelerator) continue
      const key = JSON.stringify(parseAccelerator(c.accelerator, false))
      const prev = seen.get(key)
      if (prev && !c.hidden) throw new Error(`конфликт ${c.accelerator}: ${prev} и ${c.id}`)
      if (!prev) seen.set(key, c.id)
    }
  })

  it('каждая секция объявлена в меню и имеет название', () => {
    for (const c of COMMANDS) {
      expect(MENU_SECTIONS).toContain(c.section)
      expect(SECTION_LABELS[c.section]).toBeTruthy()
    }
  })

  it('индекс по id покрывает все команды', () => {
    expect(COMMAND_BY_ID.size).toBe(COMMANDS.length)
  })

  it('каждая видимая команда есть в меню окна, и в меню только настоящие команды', () => {
    const inMenu = new Set(menuCommandIds(APP_MENU.flatMap((g) => g.items)))
    for (const c of COMMANDS) if (!c.hidden) expect(inMenu, c.id).toContain(c.id)
    for (const id of [
      ...inMenu,
      ...menuCommandIds(NODE_CONTEXT_MENU),
      ...menuCommandIds(CANVAS_CONTEXT_MENU)
    ]) {
      expect(COMMAND_BY_ID.has(id), id).toBe(true)
    }
  })

  it('меню окна — не больше пяти пунктов, ПКМ по ноде — не длиннее одиннадцати строк', () => {
    expect(APP_MENU.length).toBeLessThanOrEqual(5)
    expect(NODE_CONTEXT_MENU.length).toBeLessThanOrEqual(11)
  })
})
