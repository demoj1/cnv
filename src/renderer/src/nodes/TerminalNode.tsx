import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import { terminalSpec, withTerminalSpec } from '@core/terminal'
import { useCanvasEnv } from '@renderer/canvas/env'
import type { NodeViewProps } from './registry'

/** Шрифт задаётся в настройках, а пропорции знака берём у той же гарнитуры, что и код. */
const FONT = "'Iosevka', 'JetBrains Mono', ui-monospace, monospace"

export function TerminalNodeView({ node, active }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store, settings } = useCanvasEnv()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [shell, setShell] = useState('')

  const fontSize = settings.terminal.fontSize
  const spec = terminalSpec(node)
  const cwd = spec?.cwd

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    const term = new Terminal({
      fontFamily: FONT,
      fontSize,
      cursorBlink: true,
      allowProposedApi: true,
      // Полотно не должно мигать белым на тёмной теме до первого кадра от шелла.
      theme: { background: '#11131a', foreground: '#d5d8e0' },
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    setExited(null)

    const offData = window.api.terminal.onData((e) => {
      if (e.nodeId === node.id) term.write(e.data)
    })
    const offExit = window.api.terminal.onExit((e) => {
      if (e.nodeId !== node.id) return
      setExited(e.exitCode)
      term.write(`\r\n\x1b[90m— процесс завершился (${e.exitCode}) —\x1b[0m\r\n`)
    })
    // `cd` шелл никому не сообщает, его видит только ядро: папку приносит main.
    const offCwd = window.api.terminal.onCwd((e) => {
      if (e.nodeId !== node.id) return
      store.mutateSilent((doc) =>
        patchNodes(doc, new Map([[node.id, { extra: withTerminalSpec(node.extra, { cwd: e.cwd }) }]]))
      )
    })

    void window.api.terminal
      .start({ nodeId: node.id, cwd, cols: term.cols, rows: term.rows })
      .then((info) => {
        if (!disposed) setShell(info.shell)
      })

    const input = term.onData((data) => window.api.terminal.write(node.id, data))

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.api.terminal.resize(node.id, term.cols, term.rows)
    })
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      offCwd()
      window.api.terminal.stop(node.id)
      term.dispose()
      termRef.current = null
    }
    // cwd меняется от самого процесса — перезапускать его на это не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, fontSize, store])

  useEffect(() => {
    if (active) termRef.current?.focus()
    else termRef.current?.blur()
  }, [active])

  const title = cwd ?? ''

  return (
    <div className={active ? 'node-term node-term--active' : 'node-term'}>
      <div className="node-term__bar" data-testid="terminal-bar">
        <span className="node-term__shell">{shell || 'терминал'}</span>
        <span className="node-term__cwd" title={cwd}>
          {title}
        </span>
        {exited !== null && <span className="node-term__dead">завершён</span>}
      </div>
      <div className="node-term__screen" ref={hostRef} data-testid="terminal-screen" />
      {!active && <div className="node-term__shield" data-testid="terminal-shield" />}
    </div>
  )
}

export function TerminalNodeLowDetail(): React.JSX.Element {
  return <div className="node-lod node-lod--term" />
}
