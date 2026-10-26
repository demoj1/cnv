import { describe, expect, it } from 'vitest'
import type { CanvasDoc } from '@core/document'
import { makeEdge, makeNode } from '@core/ops'
import { applyNodePatch, buildNode, toAgentNode } from '@core/agent-ops'
import { nodeKind } from '@core/node-kind'
import { applyBoardOp, boardEvents, boardNotices, boardSpec, newBoard, type BoardSpec } from '@core/board'

const rect = { x: 0, y: 0, width: 10, height: 10 }
const doc = (nodes: CanvasDoc['nodes'], edges: CanvasDoc['edges'] = []): CanvasDoc => ({
  nodes,
  edges,
  extra: {}
})
const opts = { shell: 'sh', defaultAgent: 'claude' }

function sample(): BoardSpec {
  let b = newBoard('Спринт')
  b = applyBoardOp(b, { op: 'add_card', lane: 'Backlog', text: '# Логин\nформа', id: 'c1' })
  b = applyBoardOp(b, { op: 'add_card', lane: 'backlog', text: 'Отчёт', id: 'c2' })
  return b
}

describe('канбан-доска', () => {
  it('по умолчанию — Backlog, In progress, Done; дорожка по id или названию', () => {
    const b = sample()
    expect(b.lanes.map((l) => l.title)).toEqual(['Backlog', 'In progress', 'Done'])
    expect(b.lanes[0]!.cards.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(() => applyBoardOp(b, { op: 'add_card', lane: 'QA', text: 'x' })).toThrow(/нет дорожки «QA»/)
  })

  it('карточки двигаются между дорожками и по месту; дорожки — переставляются и удаляются', () => {
    let b = sample()
    b = applyBoardOp(b, { op: 'move_card', card: 'c2', lane: 'Backlog', index: 0 })
    expect(b.lanes[0]!.cards.map((c) => c.id)).toEqual(['c2', 'c1'])
    b = applyBoardOp(b, { op: 'move_card', card: 'c1', lane: 'Done' })
    expect(b.lanes[2]!.cards.map((c) => c.id)).toEqual(['c1'])
    b = applyBoardOp(b, { op: 'move_lane', lane: 'Done', index: 0 })
    expect(b.lanes.map((l) => l.title)).toEqual(['Done', 'Backlog', 'In progress'])
    b = applyBoardOp(b, { op: 'update_card', card: 'c1', color: '4' })
    b = applyBoardOp(b, { op: 'update_card', card: 'c1', color: null, text: 'Логин готов' })
    expect(b.lanes[0]!.cards[0]).toEqual({ id: 'c1', text: 'Логин готов' })
    b = applyBoardOp(b, { op: 'delete_lane', lane: 'Done' })
    expect(b.lanes.map((l) => l.title)).toEqual(['Backlog', 'In progress'])
    expect(() => applyBoardOp(b, { op: 'delete_card', card: 'c1' })).toThrow(/нет карточки/)
  })

  it('события: добавили, перенесли, поправили, удалили; порядок внутри дорожки — тишина', () => {
    const a = sample()
    let b = applyBoardOp(a, { op: 'move_card', card: 'c1', lane: 'In progress' })
    b = applyBoardOp(b, { op: 'update_card', card: 'c2', text: 'Отчёт v2' })
    b = applyBoardOp(b, { op: 'add_lane', title: 'QA', id: 'qa' })
    expect(boardEvents(a, b)).toEqual([
      '+ дорожка «QA»',
      '~ карточка «Отчёт v2» (id c2): поменялся текст',
      '→ карточка «Логин» (id c1): «Backlog» → «In progress»'
    ])
    expect(
      boardEvents(a, applyBoardOp(a, { op: 'move_card', card: 'c2', lane: 'Backlog', index: 0 }))
    ).toEqual([])
    expect(boardEvents(a, applyBoardOp(a, { op: 'delete_card', card: 'c2' }))).toEqual([
      '− карточка «Отчёт» (id c2) из «Backlog»'
    ])
  })

  it('письма — агентам, соединённым с доской; свои правки — не себе', () => {
    const board = buildNode(doc([]), { kind: 'board', title: 'Спринт' }, rect, opts)
    const agent = makeNode({ type: 'terminal', shell: 'sh', name: 'Даня', agent: { sessionId: '' } }, rect)
    const other = makeNode({ type: 'terminal', shell: 'sh', name: 'Лиза', agent: { sessionId: '' } }, rect)
    const before = doc([board, agent, other], [makeEdge(agent.id, board.id)])
    const after = applyNodePatch(before, board.id, {
      board: { op: 'add_card', lane: 'Done', text: 'Релиз', id: 'r' }
    })
    const [notice, ...rest] = boardNotices(before, after)
    expect(rest).toEqual([])
    expect(notice).toEqual({
      nodeId: agent.id,
      text: `доска «Спринт» (id ${board.id}):\n+ карточка «Релиз» (id r) в «Done»`
    })
    expect(boardNotices(before, after, new Set([agent.id]))).toEqual([])
  })

  it('нода доски: вид board, агент видит дорожки, текст для Obsidian — markdown, text править нельзя', () => {
    const board = buildNode(doc([]), { kind: 'board', lanes: ['Todo', 'Done'] }, rect, opts)
    expect(nodeKind(board)).toBe('board')
    const d = applyNodePatch(doc([board]), board.id, {
      board: { op: 'add_card', lane: 'Todo', text: '**Купить** молоко', id: 'm' }
    })
    const node = d.nodes[0]!
    expect(node).toMatchObject({ text: '## Доска\n\n### Todo\n- Купить молоко\n\n### Done' })
    expect(toAgentNode(node).board?.lanes[0]?.cards).toEqual([{ id: 'm', text: '**Купить** молоко' }])
    expect(boardSpec(node)?.lanes.map((l) => l.title)).toEqual(['Todo', 'Done'])
    expect(() => applyNodePatch(d, board.id, { text: 'x' })).toThrow(/board/)
    expect(() => applyNodePatch(d, board.id, { board: { op: 'delete_card', card: 'nope' } })).toThrow(
      /нет карточки/
    )
  })
})
