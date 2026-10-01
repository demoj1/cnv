import { useMemo } from 'react'
import type { CanvasColor } from '@shared/canvas'
import { renderOrder, type CanvasDoc } from '@core/document'
import { endAngle, resolveEdges } from '@core/edges'

interface Props {
  doc: CanvasDoc
  autoSides: boolean
  selection: ReadonlySet<string>
  editingId: string | null
  onEditLabel(edgeId: string): void
}

/** Размер наконечника в МИРОВЫХ единицах: масштабируется вместе с линией и холстом. */
const ARROW_LEN = 13
const ARROW_HALF = 6.5

const PRESET: Record<string, string> = {
  '1': '#e05252',
  '2': '#e08a3c',
  '3': '#d9bd3a',
  '4': '#4caf6a',
  '5': '#3ba8c4',
  '6': '#9a6ad4'
}

const colorOf = (color: CanvasColor | undefined): string => (color ? (PRESET[color] ?? color) : 'var(--edge)')

export function EdgesLayer({
  doc,
  autoSides,
  selection,
  editingId,
  onEditLabel
}: Props): React.JSX.Element {
  const edges = useMemo(() => resolveEdges(doc, autoSides), [doc, autoSides])
  // z-index ноды = её индекс в порядке отрисовки (×2, как в NodesLayer). Связь встаёт на
  // уровень верхней из двух своих нод, но на единицу ниже — чтобы не накрывать саму ноду,
  // но быть над всеми, кто ниже. Своё SVG на связь — иначе z-index в одном SVG не работает.
  const zOf = useMemo(() => {
    const m = new Map<string, number>()
    renderOrder(doc.nodes).forEach((n, i) => m.set(n.id, i * 2))
    return m
  }, [doc.nodes])

  return (
    <>
      {edges.map(({ edge, geometry }) => {
        const stroke = colorOf(edge.color)
        const selected = selection.has(edge.id)
        const z = Math.max(zOf.get(edge.fromNode) ?? 0, zOf.get(edge.toNode) ?? 0) - 1
        return (
          <svg key={edge.id} className="edges" overflow="visible" style={{ zIndex: z }}>
            <g data-edge-id={edge.id} className={selected ? 'edge edge--selected' : 'edge'}>
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
          </svg>
        )
      })}
    </>
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
      d={`M 0 0 L ${-ARROW_LEN} ${ARROW_HALF} L ${-ARROW_LEN} ${-ARROW_HALF} Z`}
      fill={fill}
      transform={`translate(${x} ${y}) rotate(${angle})`}
    />
  )
}
