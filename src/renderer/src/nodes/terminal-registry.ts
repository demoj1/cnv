import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm'
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

/**
 * Строка буфера текстом. `typedOnly` — тусклые (dim) клетки пробелами: так рисуют подсказки
 * в пустом поле ввода (Claude Code), и набранное человеком от них надо отличать.
 */
function lineText(line: IBufferLine, typedOnly: boolean, cell: IBufferCell): string {
  if (!typedOnly) return line.translateToString(true)
  let out = ''
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x, cell)
    if (!c || c.getWidth() === 0) continue
    out += c.isDim() ? ' '.repeat(c.getWidth()) : c.getChars() || ' '
  }
  return out.trimEnd()
}

export function readTerminalScreen(
  nodeId: string,
  lines: number,
  typedOnly = false
): AgentTerminalScreen | null {
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
  const cell = buffer.getNullCell()
  for (let i = start; i < end; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const text = lineText(line, typedOnly, cell)
    // Перенесённая строка — продолжение предыдущей, склеиваем обратно.
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text
    else out.push(text)
  }
  return { text: out.join('\n'), cols: term.cols, rows: term.rows, total: buffer.length }
}

/** Выделенный текст терминала — для e2e: по картинке выделения слово не проверить надёжно. */
Object.assign(window, {
  __cnvTerminalSelection: (nodeId: string): string | null => terminals.get(nodeId)?.getSelection() ?? null
})

const restartListeners = new Map<string, Set<() => void>>()

/** Перезапустить процесс терминала (агенту сменили сессию — пусть продолжит её). */
export function requestTerminalRestart(nodeId: string): void {
  for (const l of restartListeners.get(nodeId) ?? []) l()
}

export function onTerminalRestart(nodeId: string, listener: () => void): () => void {
  const set = restartListeners.get(nodeId) ?? new Set()
  set.add(listener)
  restartListeners.set(nodeId, set)
  return () => set.delete(listener)
}
