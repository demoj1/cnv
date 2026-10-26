import { useMemo, useState } from 'react'
import type { DocNode } from '@core/document'
import type { DocStore } from '@core/doc-store'
import { applyNodePatch } from '@core/agent-ops'
import { boardSpec, type BoardCard, type BoardOp } from '@core/board'
import { useCanvasEnv } from '@renderer/canvas/env'
import { resolveFontFamily, textEdit } from '@core/text-edit'
import { renderMarkdown } from './markdown'
import type { NodeViewProps } from './registry'

/** Правка доски человеком — тем же путём, что у агентов: одна запись в истории. */
export function mutateBoard(store: DocStore, boardId: string, op: BoardOp, label: string): void {
  store.mutate(label, (doc) =>
    doc.nodes.some((n) => n.id === boardId) ? applyNodePatch(doc, boardId, { board: op }) : doc
  )
}

/** Поле правки названия: Enter — сохранить, Esc и уход фокуса — как есть. */
function TitleInput(props: { value: string; onDone(value: string | null): void }): React.JSX.Element {
  const [value, setValue] = useState(props.value)
  return (
    <input
      className="board__title-input"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => props.onDone(value.trim() && value !== props.value ? value : null)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') props.onDone(null)
      }}
    />
  )
}

function CardView({ card }: { card: BoardCard }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(card.text), [card.text])
  return (
    <div
      className={`board-card${card.color && !card.color.startsWith('#') ? ` board-card--colored swatch--${card.color}` : card.color ? ' board-card--colored' : ''}`}
      style={
        card.color?.startsWith('#') ? ({ '--node-color': card.color } as React.CSSProperties) : undefined
      }
      data-board-card={card.id}
      data-testid="board-card"
      title="Двойной клик — править; тащи — на другую дорожку или на холст"
    >
      {/* markdown уже прогнан через DOMPurify в renderMarkdown */}
      <div className="board-card__body node-text" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

/**
 * Канбан-доска: дорожки в ряд, у каждой свой скролл. Карточки тащит холст
 * (useCanvasInteractions): между дорожками, с доски на холст и с холста на доску.
 */
export function BoardNodeView({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store, editCard, settings } = useCanvasEnv()
  const spec = boardSpec(node)
  // Шрифт — как у карточек: из настроек, а «Aa» под доской задаёт ей свой.
  const edit = textEdit(node)
  const font: React.CSSProperties = {
    fontSize: edit?.fontSize ?? settings.nodes.defaultFontSize,
    fontFamily: resolveFontFamily(edit?.fontFamily)
  }
  const [renaming, setRenaming] = useState<string | null>(null)
  if (!spec) return <div className="board" />

  const run = (op: BoardOp, label: string): void => mutateBoard(store, node.id, op, label)

  return (
    <div className="board" data-testid="board" style={font}>
      <div className="board__header">
        {renaming === 'board' ? (
          <TitleInput
            value={spec.title}
            onDone={(v) => {
              setRenaming(null)
              if (v) run({ op: 'rename', title: v }, 'название доски')
            }}
          />
        ) : (
          <span
            className="board__title"
            title="Двойной клик — переименовать"
            onDoubleClick={() => setRenaming('board')}
          >
            {spec.title}
          </span>
        )}
        <button
          type="button"
          className="board__add-lane"
          data-testid="board-add-lane"
          title="Новая дорожка"
          onClick={() => run({ op: 'add_lane', title: 'Новая дорожка' }, 'новая дорожка')}
        >
          ＋ дорожка
        </button>
      </div>
      <div className="board__lanes">
        {spec.lanes.map((lane, i) => (
          <div
            key={lane.id}
            className="board-lane"
            data-board-lane={lane.id}
            data-board-id={node.id}
            data-testid="board-lane"
          >
            <div className="board-lane__header">
              {renaming === lane.id ? (
                <TitleInput
                  value={lane.title}
                  onDone={(v) => {
                    setRenaming(null)
                    if (v) run({ op: 'rename_lane', lane: lane.id, title: v }, 'название дорожки')
                  }}
                />
              ) : (
                <span
                  className="board-lane__title"
                  title="Двойной клик — переименовать"
                  data-testid="board-lane-title"
                  onDoubleClick={() => setRenaming(lane.id)}
                >
                  {lane.title}
                </span>
              )}
              <span className="board-lane__count">{lane.cards.length}</span>
              <span className="board-lane__tools">
                <button
                  type="button"
                  title="Сдвинуть влево"
                  disabled={i === 0}
                  onClick={() => run({ op: 'move_lane', lane: lane.id, index: i - 1 }, 'порядок дорожек')}
                >
                  ‹
                </button>
                <button
                  type="button"
                  title="Сдвинуть вправо"
                  disabled={i === spec.lanes.length - 1}
                  onClick={() => run({ op: 'move_lane', lane: lane.id, index: i + 1 }, 'порядок дорожек')}
                >
                  ›
                </button>
                <button
                  type="button"
                  title="Удалить дорожку"
                  data-testid="board-delete-lane"
                  onClick={() => {
                    if (lane.cards.length && !window.confirm(`Удалить «${lane.title}» вместе с карточками?`))
                      return
                    run({ op: 'delete_lane', lane: lane.id }, 'удалить дорожку')
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            <div className="board-lane__cards" data-board-lane-scroll>
              {lane.cards.map((card) => (
                <CardView key={card.id} card={card} />
              ))}
            </div>
            <button
              type="button"
              className="board-lane__add"
              data-testid="board-add-card"
              onClick={() => editCard(node.id, { lane: lane.id })}
            >
              ＋ карточка
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BoardNodeLowDetail({ node }: NodeViewProps<DocNode>): React.JSX.Element {
  const spec = boardSpec(node)
  return (
    <div className="board board--lod">
      <div className="board__title">{spec?.title}</div>
      <div className="board__lanes">
        {spec?.lanes.map((lane) => (
          <div key={lane.id} className="board-lane">
            {lane.cards.map((c) => (
              <div key={c.id} className="board-card board-card--lod" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
