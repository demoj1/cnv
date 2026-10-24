import { useEffect, useMemo, useRef } from 'react'
import type { CanvasColor } from '@shared/canvas'
import { renderOrder, type CanvasDoc } from '@core/document'
import { cubicAt, edgeGeometry, endAngle, resolveEdges, type EdgeGeometry } from '@core/edges'
import { visualBounds } from '@core/image-edit'
import { PULSE_MS, useEdgePulses } from './edge-pulses'

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

export function EdgesLayer({ doc, autoSides, selection, editingId, onEditLabel }: Props): React.JSX.Element {
  const edges = useMemo(() => resolveEdges(doc, autoSides), [doc, autoSides])
  const { pulses, ghosts } = useEdgePulses()
  const byId = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes])
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
        const running = pulses.filter((p) => p.edge === edge.id)
        const z = Math.max(zOf.get(edge.fromNode) ?? 0, zOf.get(edge.toNode) ?? 0) - 1
        return (
          <svg key={edge.id} className="edges" overflow="visible" style={{ zIndex: z }}>
            <g
              data-edge-id={edge.id}
              className={`edge${selected ? ' edge--selected' : ''}${running.length > 0 ? ' edge--pulsing' : ''}`}
            >
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
              {running.map((p) => (
                <Pulse key={p.key} geometry={geometry} reverse={p.reverse} color={stroke} />
              ))}
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
      {ghosts.map((g) => {
        const from = byId.get(g.from)
        const to = byId.get(g.to)
        if (!from || !to) return null
        const geometry = edgeGeometry(visualBounds(from), visualBounds(to))
        return (
          <svg key={g.key} className="edges edge-ghost" overflow="visible" style={{ zIndex: 1_000_000 }}>
            <path className="edge-ghost__trail" d={geometry.path} />
            <Pulse geometry={geometry} reverse={false} color="var(--accent)" />
          </svg>
        )
      })}
    </>
  )
}

/**
 * Светящаяся точка, бегущая по кривой связи. Позиция считается кадрами по той же кривой
 * Безье, что и линия, — без SMIL: у вставленных на лету <animateMotion> время старта капризное.
 */
/** Хвост кометы: сколько точек и на сколько каждая отстаёт по кривой. */
const TAIL = [0.035, 0.07, 0.105, 0.14]

function Pulse({
  geometry,
  reverse,
  color
}: {
  geometry: EdgeGeometry
  reverse: boolean
  color: string
}): React.JSX.Element {
  const group = useRef<SVGGElement>(null)
  useEffect(() => {
    const start = performance.now()
    let frame = 0
    const at = (t: number): { x: number; y: number } =>
      cubicAt(geometry.from, geometry.c1, geometry.c2, geometry.to, Math.min(1, Math.max(0, t)))
    const step = (now: number): void => {
      const raw = Math.min(1, (now - start) / PULSE_MS)
      // Разгон и торможение — импульс «летит», а не ползёт.
      const eased = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2
      const parts = group.current?.children
      if (parts) {
        // Голова и хвост: хвост отстаёт по кривой назад, против направления бега.
        ;[0, ...TAIL].forEach((lag, i) => {
          const t = eased - lag
          const p = at(reverse ? 1 - t : t)
          parts[i]?.setAttribute('transform', `translate(${p.x} ${p.y})`)
          parts[i]?.setAttribute('opacity', String(t < 0 ? 0 : 1))
        })
        group.current?.setAttribute('opacity', String(raw < 0.85 ? 1 : (1 - raw) / 0.15))
      }
      if (raw < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [geometry, reverse])
  return (
    <g ref={group} className="edge-pulse" style={{ color }}>
      <g>
        <circle r={16} className="edge-pulse__halo" />
        <circle r={6} className="edge-pulse__dot" />
      </g>
      {TAIL.map((_, i) => (
        <g key={i} opacity={0}>
          <circle r={5 - i} className="edge-pulse__tail" style={{ opacity: 0.7 - i * 0.15 }} />
        </g>
      ))}
    </g>
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
