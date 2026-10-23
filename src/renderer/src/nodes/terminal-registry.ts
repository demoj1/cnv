import type { Terminal } from '@xterm/xterm'
import type { AgentTerminalScreen } from '@shared/agent'

/**
 * Живые xterm-ы по id ноды: агенту из MCP экран соседа нужен таким, каким его видит
 * человек, а не сырым потоком с escape-кодами — это знает только xterm.
 */
const terminals = new Map<string, Terminal>()

export function registerTerminal(nodeId: string, term: Terminal): () => void {
  terminals.set(nodeId, term)
  return () => {
    if (terminals.get(nodeId) === term) terminals.delete(nodeId)
  }
}

export function readTerminalScreen(nodeId: string, lines: number): AgentTerminalScreen | null {
  const term = terminals.get(nodeId)
  if (!term) return null
  const buffer = term.buffer.active
  // Хвост из пустых строк под курсором агенту не нужен — режем по последней непустой.
  let end = buffer.length
  while (
    end > 0 &&
    !buffer
      .getLine(end - 1)
      ?.translateToString(true)
      .trim()
  )
    end--
  const start = Math.max(0, end - lines)
  const out: string[] = []
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    // Перенесённая строка — продолжение предыдущей, склеиваем обратно.
    if (line.isWrapped && out.length > 0) out[out.length - 1] += line.translateToString(true)
    else out.push(line.translateToString(true))
  }
  return { text: out.join('\n'), cols: term.cols, rows: term.rows, total: buffer.length }
}
