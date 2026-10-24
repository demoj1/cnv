import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { COMMAND_BY_ID, SEP, menuCommandIds, type MenuEntry } from '@shared/commands'

export interface ContextMenuState {
  x: number
  y: number
  entries: readonly MenuEntry[]
}

interface Props {
  state: ContextMenuState
  enabled: Record<string, boolean>
  onRun(commandId: string): void
  onClose(): void
}

/**
 * ПКМ-меню — дерево из shared/commands: подменю раскрываются при наведении вправо, а если
 * справа не влезают — влево. Само меню у края окна сдвигается внутрь.
 */
export function ContextMenu({ state, enabled, onRun, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: state.x, y: state.y })

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

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(state.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(state.y, window.innerHeight - r.height - 4))
    })
  }, [state.x, state.y])

  const run = (id: string): void => {
    onClose()
    onRun(id)
  }

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} data-testid="context-menu">
      <Items entries={state.entries} enabled={enabled} onRun={run} />
    </div>
  )
}

function Items({
  entries,
  enabled,
  onRun
}: {
  entries: readonly MenuEntry[]
  enabled: Record<string, boolean>
  onRun(id: string): void
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry, i) => {
        if (entry === SEP) return <div key={`sep${i}`} className="context-menu__sep" />
        if (typeof entry !== 'string') {
          return (
            <Submenu
              key={entry.label}
              label={entry.label}
              entries={entry.items}
              enabled={enabled}
              onRun={onRun}
            />
          )
        }
        const command = COMMAND_BY_ID.get(entry)
        if (!command) return null
        const disabled = enabled[entry] === false
        return (
          <button
            key={entry}
            type="button"
            className="context-menu__item"
            disabled={disabled}
            data-command={entry}
            onClick={() => !disabled && onRun(entry)}
          >
            <span>{command.label}</span>
            {command.accelerator && <kbd>{command.accelerator.replace('CmdOrCtrl', 'Ctrl')}</kbd>}
          </button>
        )
      })}
    </>
  )
}

function Submenu({
  label,
  entries,
  enabled,
  onRun
}: {
  label: string
  entries: readonly MenuEntry[]
  enabled: Record<string, boolean>
  onRun(id: string): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [left, setLeft] = useState(false)
  const [lift, setLift] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Подменю, где всё недоступно, тоже недоступно: нечего раскрывать.
  const disabled = menuCommandIds(entries).every((id) => enabled[id] === false)

  useLayoutEffect(() => {
    if (!open || !listRef.current || !ref.current) return
    const item = ref.current.getBoundingClientRect()
    const list = listRef.current.getBoundingClientRect()
    setLeft(item.right + list.width > window.innerWidth - 4)
    // Внизу окна подменю поднимается, чтобы не уйти за край.
    setLift(Math.max(0, list.bottom - window.innerHeight + 4))
  }, [open])

  return (
    <div
      className="context-menu__sub"
      ref={ref}
      data-submenu={label}
      onPointerEnter={() => !disabled && setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="context-menu__item"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span>{label}</span>
        <span className="context-menu__arrow">▸</span>
      </button>
      {open && (
        <div
          ref={listRef}
          className={`context-menu context-menu--sub${left ? ' context-menu--left' : ''}`}
          style={lift ? { marginTop: -lift } : undefined}
          data-testid="context-submenu"
        >
          <Items entries={entries} enabled={enabled} onRun={onRun} />
        </div>
      )}
    </div>
  )
}
