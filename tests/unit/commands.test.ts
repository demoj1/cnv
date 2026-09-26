import { describe, expect, it } from 'vitest'
import { COMMANDS, COMMAND_BY_ID, MENU_SECTIONS, SECTION_LABELS } from '@shared/commands'
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
})
