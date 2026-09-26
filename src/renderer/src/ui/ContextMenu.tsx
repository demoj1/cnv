import { useEffect, useRef } from 'react'
import { COMMAND_BY_ID } from '@shared/commands'

export interface ContextMenuState {
  x: number
  y: number
  commandIds: readonly string[]
}

interface Props {
  state: ContextMenuState
  enabled: Record<string, boolean>
  onRun(commandId: string): void
  onClose(): void
}

export function ContextMenu({ state, enabled, onRun, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left: state.x, top: state.y }}
      data-testid="context-menu"
    >
      {state.commandIds.map((id, i) => {
        if (id === '-') return <div key={`sep${i}`} className="context-menu__sep" />
        const command = COMMAND_BY_ID.get(id)
        if (!command) return null
        const disabled = enabled[id] === false
        return (
          <button
            key={id}
            type="button"
            className="context-menu__item"
            disabled={disabled}
            data-command={id}
            onClick={() => {
              onClose()
              if (!disabled) onRun(id)
            }}
          >
            <span>{command.label}</span>
            {command.accelerator && <kbd>{command.accelerator}</kbd>}
          </button>
        )
      })}
    </div>
  )
}
