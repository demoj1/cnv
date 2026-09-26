import { useMemo } from 'react'
import type { CanvasColor } from '@shared/canvas'
import type { CanvasDoc } from '@core/document'
import { endAngle, resolveEdges } from '@core/edges'

interface Props {
  doc: CanvasDoc
  selection: ReadonlySet<string>
  editingId: string | null
  onEditLabel(edgeId: string): void
}

const PRESET: Record<string, string> = {
  '1': '#e05252',
  '2': '#e08a3c',
  '3': '#d9bd3a',
  '4': '#4caf6a',
  '5': '#3ba8c4',
  '6': '#9a6ad4'
}

const colorOf = (color: CanvasColor | undefined): string => (color ? (PRESET[color] ?? color) : 'var(--edge)')

export function EdgesLayer({ doc, selection, editingId, onEditLabel }: Props): React.JSX.Element {
  const edges = useMemo(() => resolveEdges(doc), [doc])

  return (
    <svg className="edges" overflow="visible">
      {edges.map(({ edge, geometry }) => {
        const stroke = colorOf(edge.color)
        const selected = selection.has(edge.id)
        return (
          <g key={edge.id} data-edge-id={edge.id} className={selected ? 'edge edge--selected' : 'edge'}>
            <path className="edge__hit" d={geometry.path} />
            <path className="edge__line" d={geometry.path} stroke={stroke} />
            {edge.fromEnd === 'arrow' && (
              <Arrow
                x={geometry.from.x}
                y={geometry.from.y}
                angle={endAngle(geometry.fromSide)}
                fill={stroke}
              />
            )}
            {edge.toEnd !== 'none' && (
              <Arrow
                x={geometry.to.x}
                y={geometry.to.y}
                angle={endAngle(geometry.toSide) + 180}
                fill={stroke}
              />
            )}
            {edge.label && editingId !== edge.id && (
              <g
                className="edge__label"
                transform={`translate(${geometry.labelAt.x} ${geometry.labelAt.y})`}
                onDoubleClick={() => onEditLabel(edge.id)}
              >
                <text textAnchor="middle" dominantBaseline="middle">
                  {edge.label}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function Arrow({
  x,
  y,
  angle,
  fill
}: {
  x: number
  y: number
  angle: number
  fill: string
}): React.JSX.Element {
  return (
    <path
      className="edge__arrow"
      d="M 0 0 L -11 5 L -11 -5 Z"
      fill={fill}
      transform={`translate(${x} ${y}) rotate(${angle})`}
    />
  )
}
