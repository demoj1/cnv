import { useEffect, useInsertionEffect, useRef } from 'react'
import { COMMANDS } from '@shared/commands'
import { matchesAccelerator, parseAccelerator } from '@core/accelerator'

export type CommandHandlers = Record<string, () => void>

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  return !!el.closest?.('input, textarea, select, .cm-editor')
}

export function useCommands(handlers: CommandHandlers): void {
  const ref = useRef(handlers)
  useInsertionEffect(() => {
    ref.current = handlers
  })

  useEffect(() => {
    const isMac = window.api.platform.isMac
    const bindings = COMMANDS.filter((c) => c.accelerator).map((c) => ({
      id: c.id,
      parsed: parseAccelerator(c.accelerator as string, isMac)
    }))

    const onKeyDown = (e: KeyboardEvent): void => {
      const textEntry = isTextEntry(e.target)
      for (const b of bindings) {
        if (!matchesAccelerator(b.parsed, e)) continue
        // В поле ввода отдаём только Escape, остальное — редактору.
        if (textEntry && b.id !== 'selection.none') continue
        const handler = ref.current[b.id]
        if (!handler) continue
        e.preventDefault()
        handler()
        return
      }
    }

    window.addEventListener('keydown', onKeyDown)
    const offMenu = window.api.menu.onCommand((id) => ref.current[id]?.())
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      offMenu()
    }
  }, [])
}
