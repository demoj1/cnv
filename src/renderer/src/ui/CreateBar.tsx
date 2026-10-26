import { useEffect, useRef, useState } from 'react'
import { screenToWorld } from '@core/camera'
import type { CameraController } from '@core/camera-controller'
import type { Point, Size } from '@core/geometry'
import { COMMAND_BY_ID } from '@shared/commands'

export type CreateKind = 'text' | 'web' | 'file' | 'terminal' | 'agent' | 'portal' | 'timer'

interface Item {
  kind: CreateKind
  command: string
  icon: React.JSX.Element
}

const svg = (body: React.ReactNode): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    {body}
  </svg>
)

const ITEMS: readonly Item[] = [
  {
    kind: 'text',
    command: 'create.text',
    icon: svg(
      <>
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
        <path d="M5 6h6M5 8.5h6M5 11h3.5" />
      </>
    )
  },
  {
    kind: 'web',
    command: 'create.web',
    icon: svg(
      <>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" />
      </>
    )
  },
  {
    kind: 'file',
    command: 'create.file',
    icon: svg(<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />)
  },
  {
    kind: 'terminal',
    command: 'create.terminal',
    icon: svg(
      <>
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3" />
      </>
    )
  },
  {
    kind: 'agent',
    command: 'create.agent',
    icon: svg(<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M12 4l-1.8 1.8M5.8 10.2 4 12" />)
  },
  {
    kind: 'portal',
    command: 'create.portal',
    icon: svg(
      <>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2.5" />
        <path d="M8 2.5v2M8 11.5v2" />
      </>
    )
  },
  {
    kind: 'timer',
    command: 'create.timer',
    icon: svg(
      <>
        <circle cx="8" cy="9" r="5" />
        <path d="M8 9V6.5M6.5 2h3M8 2v2" />
      </>
    )
  }
]

/** Сдвиг мыши, после которого нажатие — уже перетаскивание, а не клик. */
const DRAG_THRESHOLD = 4

interface Drag {
  kind: CreateKind
  /** Какой агент — для kind=agent из списка агентов; нет — агент по умолчанию. */
  agent?: string
  start: Point
  /** Курсор над холстом — туда и встанет нода; null — пока над самой панелью или ещё не тянули. */
  at: Point | null
}

interface Props {
  camera: CameraController
  viewportRef: React.RefObject<HTMLDivElement | null>
  sizeOf(kind: CreateKind): Size
  /** `at` — центр будущей ноды в мировых координатах; null — центр экрана. */
  onCreate(kind: CreateKind, at: Point | null, agent?: string): void
  /** Все виды агентов: правый клик по ✦ открывает их список. */
  agents: readonly { id: string; label: string }[]
  defaultAgent: string
  /** «Продолжить сессию…»: агент по умолчанию с выбранной старой сессией. */
  onResume(at: Point | null): void
}

/**
 * Полоса создания слева: клик — нода в центре экрана, как по хоткею; перетаскивание —
 * туда, где отпустил. Тянем на pointer-событиях, а не HTML5 drag&drop: над живой
 * веб-страницей тот обрывается — её webview забирает событие себе.
 */
export function CreateBar({
  camera,
  viewportRef,
  sizeOf,
  onCreate,
  agents,
  defaultAgent,
  onResume
}: Props): React.JSX.Element {
  const [drag, setDrag] = useState<Drag | null>(null)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    // Пока тянем, webview и терминалы не должны перехватывать мышь.
    document.body.classList.add('is-creating')
    return () => document.body.classList.remove('is-creating')
  }, [dragging])

  useEffect(() => {
    if (!agentsOpen) return
    const close = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setAgentsOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [agentsOpen])

  const update = (next: Drag | null): void => {
    dragRef.current = next
    setDrag(next)
  }

  const onPointerDown = (kind: CreateKind, agent?: string) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    update({ kind, ...(agent ? { agent } : {}), start: { x: e.clientX, y: e.clientY }, at: null })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const current = dragRef.current
    if (!current) return
    const moved = Math.hypot(e.clientX - current.start.x, e.clientY - current.start.y)
    if (moved < DRAG_THRESHOLD && !current.at) return
    const overBar = barRef.current?.contains(document.elementFromPoint(e.clientX, e.clientY) ?? null)
    update({ ...current, at: overBar ? null : { x: e.clientX, y: e.clientY } })
  }

  const finish = (e: React.PointerEvent<HTMLButtonElement>, cancel: boolean): void => {
    const current = dragRef.current
    if (!current) return
    update(null)
    if (cancel) return
    const moved = Math.hypot(e.clientX - current.start.x, e.clientY - current.start.y)
    if (moved < DRAG_THRESHOLD) {
      setAgentsOpen(false)
      onCreate(current.kind, null, current.agent)
      return
    }
    const viewport = viewportRef.current?.getBoundingClientRect()
    if (!current.at || !viewport) return
    setAgentsOpen(false)
    onCreate(
      current.kind,
      screenToWorld(camera.value, { x: current.at.x - viewport.left, y: current.at.y - viewport.top }),
      current.agent
    )
  }

  const ghost = drag?.at ? sizeOf(drag.kind) : null
  const zoom = camera.value.zoom

  return (
    <>
      <div className="create-bar" ref={barRef} data-testid="create-bar">
        {ITEMS.map((item) => {
          const def = COMMAND_BY_ID.get(item.command)
          const hotkey = def?.accelerator?.replace('CmdOrCtrl', 'Ctrl')
          const isAgent = item.kind === 'agent'
          const label = isAgent
            ? `Агент: ${agents.find((a) => a.id === defaultAgent)?.label ?? defaultAgent}`
            : (def?.label ?? item.kind)
          return (
            <button
              key={item.kind}
              type="button"
              className="create-bar__item"
              data-kind={item.kind}
              title={`${label}${hotkey ? ` (${hotkey})` : ''} — клик или тяни на холст${isAgent ? '; правый клик — другие агенты' : ''}`}
              onContextMenu={(e) => {
                if (!isAgent) return
                e.preventDefault()
                setAgentsOpen((v) => !v)
              }}
              onPointerDown={onPointerDown(item.kind)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => finish(e, false)}
              onPointerCancel={(e) => finish(e, true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onCreate(item.kind, null)
              }}
            >
              {item.icon}
            </button>
          )
        })}
        {agentsOpen && (
          <div className="create-bar__agents" data-testid="create-agents">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                className="create-bar__agent"
                data-agent={a.id}
                title={`${a.label} — клик или тяни на холст`}
                onPointerDown={onPointerDown('agent', a.id)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => finish(e, false)}
                onPointerCancel={(e) => finish(e, true)}
              >
                ✦ {a.label}
              </button>
            ))}
            <button
              type="button"
              className="create-bar__agent create-bar__agent--resume"
              data-testid="create-resume"
              title="Агент по умолчанию — продолжить одну из прошлых сессий"
              onClick={() => {
                setAgentsOpen(false)
                onResume(null)
              }}
            >
              ⟲ Продолжить сессию…
            </button>
          </div>
        )}
      </div>
      {drag?.at && ghost && (
        <div
          className="create-ghost"
          data-testid="create-ghost"
          style={{
            left: drag.at.x - (ghost.width * zoom) / 2,
            top: drag.at.y - (ghost.height * zoom) / 2,
            width: ghost.width * zoom,
            height: ghost.height * zoom
          }}
        />
      )}
    </>
  )
}
