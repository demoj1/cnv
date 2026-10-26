import { useEffect, useState } from 'react'
import type { DocNode } from '@core/document'
import { applyNodePatch } from '@core/agent-ops'
import type { AgentNodePatch } from '@shared/agent'
import {
  TIMER_MAX_EVERY,
  TIMER_MIN_EVERY,
  formatEvery,
  formatLeft,
  timerLeftMs,
  timerSpec,
  timerTargets
} from '@core/timer'
import { useCanvasEnv } from '@renderer/canvas/env'
import type { NodeViewProps } from './registry'

const RING_R = 52
const RING_LEN = 2 * Math.PI * RING_R
/** Знак паузы текстом, а не цветным emoji. */
const PAUSE = '⏸\uFE0E'

/** Текущее время, раз в секунду — пока таймер идёт. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/**
 * Таймер — кружок, который раз в N минут шлёт письмо агентам, соединённым с ним связью.
 * Кольцо — сколько прошло от прошлого тика, в центре — сколько осталось до следующего.
 */
export function TimerNodeView({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store } = useCanvasEnv()
  const spec = timerSpec(node)
  const now = useNow(!!spec && !spec.paused)
  const [editing, setEditing] = useState<{ every: string; message: string } | null>(null)
  if (!spec) return <div className="node-timer" />

  const targets = timerTargets(store.doc, node.id).length
  const left = timerLeftMs(spec, now)
  const done = 1 - left / (spec.every * 60_000)
  const silent = !spec.message.trim()
  const state = spec.paused ? 'paused' : silent || !targets ? 'idle' : 'running'

  const patch = (p: AgentNodePatch, what: string): void =>
    store.mutate(what, (doc) =>
      doc.nodes.some((n) => n.id === node.id) ? applyNodePatch(doc, node.id, p) : doc
    )

  const save = (): void => {
    if (!editing) return
    const every = Number(editing.every.replace(',', '.'))
    setEditing(null)
    const next: AgentNodePatch = {}
    if (
      Number.isFinite(every) &&
      every >= TIMER_MIN_EVERY &&
      every <= TIMER_MAX_EVERY &&
      Math.round(every) !== spec.every
    )
      next.every = every
    if (editing.message !== spec.message) next.message = editing.message
    if (Object.keys(next).length) patch(next, 'таймер')
  }

  const hint = [
    `каждые ${formatEvery(spec.every)}`,
    spec.paused
      ? 'на паузе'
      : silent
        ? 'нет сообщения'
        : !targets
          ? 'не соединён ни с одним агентом'
          : `агентов: ${targets}`,
    spec.message
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className={`node-timer node-timer--${state}`} data-testid="timer" data-state={state}>
      <div className="node-timer__circle" title={hint}>
        <svg className="node-timer__ring" viewBox="0 0 120 120" aria-hidden>
          <circle className="node-timer__track" cx="60" cy="60" r={RING_R} />
          {done > 0.01 && (
            <circle
              className="node-timer__progress"
              cx="60"
              cy="60"
              r={RING_R}
              strokeDasharray={`${RING_LEN * Math.min(1, Math.max(0, done))} ${RING_LEN}`}
            />
          )}
        </svg>
        <span className="node-timer__left" data-testid="timer-left">
          {spec.paused ? PAUSE : formatLeft(left)}
        </span>
        <span className="node-timer__every">{formatEvery(spec.every)}</span>
      </div>

      {editing ? (
        <div className="node-timer__form" onKeyDown={(e) => e.stopPropagation()}>
          <label className="node-timer__field">
            каждые
            <input
              className="node-timer__every-input"
              data-testid="timer-every"
              type="number"
              min={TIMER_MIN_EVERY}
              max={TIMER_MAX_EVERY}
              value={editing.every}
              onChange={(e) => setEditing({ ...editing, every: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
            мин
          </label>
          <textarea
            className="node-timer__message-input"
            data-testid="timer-message"
            placeholder="что прислать агентам"
            value={editing.message}
            autoFocus
            onChange={(e) => setEditing({ ...editing, message: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
              if (e.key === 'Escape') setEditing(null)
            }}
          />
          <div className="node-timer__buttons">
            <button type="button" data-testid="timer-save" onClick={save} title="Сохранить (Ctrl+Enter)">
              ✓
            </button>
            <button type="button" onClick={() => setEditing(null)} title="Отмена (Esc)">
              ✕
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={silent ? 'node-timer__message node-timer__message--empty' : 'node-timer__message'}>
            {silent ? 'впиши сообщение ✎' : spec.message}
          </div>
          <div className="node-timer__buttons">
            <button
              type="button"
              data-testid="timer-edit"
              title="Сообщение и интервал"
              onClick={() => setEditing({ every: String(spec.every), message: spec.message })}
            >
              ✎
            </button>
            <button
              type="button"
              data-testid="timer-pause"
              title={spec.paused ? 'Запустить — отсчёт заново' : 'Пауза'}
              onClick={() =>
                patch({ paused: !spec.paused }, spec.paused ? 'запустить таймер' : 'пауза таймера')
              }
            >
              {spec.paused ? '▶\uFE0E' : PAUSE}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function TimerNodeLowDetail({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const spec = timerSpec(node)
  return (
    <div className={`node-timer node-timer--lod node-timer--${spec?.paused ? 'paused' : 'running'}`}>
      <div className="node-timer__circle" />
    </div>
  )
}
