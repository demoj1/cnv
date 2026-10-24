import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import { terminalSpec, withAgentSession, withTerminalSpec, withoutAgentPrompt } from '@core/terminal'
import { useCanvasEnv } from '@renderer/canvas/env'
import type { NodeViewProps } from './registry'
import { registerTerminal } from './terminal-registry'
import { unscaleTerminalMouse } from './terminal-mouse'
import { agentLabel, useAgentPlugins } from '@renderer/workspace/useAgentPlugins'

/** Шрифт задаётся в настройках, а пропорции знака берём у той же гарнитуры, что и код. */
const FONT = "'Iosevka', 'JetBrains Mono', ui-monospace, monospace"

export function TerminalNodeView({ node, active }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store, settings, editRole } = useCanvasEnv()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [shell, setShell] = useState('')

  const fontSize = settings.terminal.fontSize
  const spec = terminalSpec(node)
  const cwd = spec?.cwd
  const name = spec?.name
  const role = spec?.role
  const agentSpec = spec?.agent
  const sessionId = agentSpec?.sessionId
  const plugins = useAgentPlugins()

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
    const restoreMouse = unscaleTerminalMouse(host)
    termRef.current = term
    const unregister = registerTerminal(node.id, term)
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
    // Берём ноду из стора, а не из замыкания: имя и сессию могли выдать уже после монтирования.
    const current = (): DocNode | undefined => store.doc.nodes.find((n) => n.id === node.id)
    const offCwd = window.api.terminal.onCwd((e) => {
      if (e.nodeId !== node.id) return
      const live = current()
      if (!live) return
      store.mutateSilent((doc) =>
        patchNodes(doc, new Map([[node.id, { extra: withTerminalSpec(live.extra, { cwd: e.cwd }) }]]))
      )
    })

    // Агент начал сессию — запоминаем: следующий запуск её продолжит. Мимо истории: это
    // не правка человека, а знание о процессе, как и папка.
    const offSession = window.api.terminal.onAgentSession((e) => {
      if (e.nodeId !== node.id) return
      const live = current()
      const liveAgent = live ? terminalSpec(live)?.agent : undefined
      if (!live || !liveAgent || liveAgent.sessionId === e.sessionId) return
      store.mutateSilent((doc) =>
        patchNodes(doc, new Map([[node.id, { extra: withAgentSession(live.extra, liveAgent, e.sessionId) }]]))
      )
    })

    const startSpec = terminalSpec(current() ?? node)
    const agent = startSpec?.agent
    void window.api.terminal
      .start({
        nodeId: node.id,
        cwd,
        cols: term.cols,
        rows: term.rows,
        ...(startSpec?.name ? { name: startSpec.name } : {}),
        ...(startSpec?.role ? { role: startSpec.role } : {}),
        ...(agent ? { agent } : {})
      })
      .then((info) => {
        if (disposed) return
        setShell(info.shell)
        // Первое задание агенту одноразовое: ушло в команду запуска — из документа его долой.
        // Берём агента из живой ноды: id сессии мог прийти раньше этого ответа.
        const live = current()
        const liveAgent = live ? terminalSpec(live)?.agent : undefined
        if (live && liveAgent?.prompt !== undefined) {
          store.mutateSilent((doc) =>
            patchNodes(doc, new Map([[node.id, { extra: withoutAgentPrompt(live.extra, liveAgent) }]]))
          )
        }
      })

    const input = term.onData((data) => window.api.terminal.write(node.id, data))

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.api.terminal.resize(node.id, term.cols, term.rows)
    })
    observer.observe(host)

    return () => {
      disposed = true
      restoreMouse()
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      offCwd()
      offSession()
      unregister()
      window.api.terminal.stop(node.id)
      term.dispose()
      termRef.current = null
    }
    // cwd и сессию приносит сам процесс — перезапускать его на это не нужно. Копию агента
    // с чужой сессией разводит main: занятую сессию он не продолжает, а начинает свою.
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
        {name && (
          <span
            className="node-term__name"
            data-testid="terminal-name"
            title={agentSpec ? `сессия ${sessionId || 'ещё не начата'}` : node.id}
          >
            {agentSpec ? '✦ ' : ''}
            {name}
          </span>
        )}
        <RoleButton role={role} onClick={() => editRole(node.id)} />
        {agentSpec ? (
          <span className="node-term__shell" data-testid="terminal-agent">
            {agentLabel(plugins, agentSpec.plugin ?? 'claude')}
          </span>
        ) : (
          <span className="node-term__shell">{shell || 'терминал'}</span>
        )}
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

/**
 * Роль в шапке — она же кнопка: клик открывает диалог роли. Нажатие не должно доходить до
 * холста, иначе он начнёт тащить ноду; холст слушает нативный pointerdown, поэтому
 * React-овский stopPropagation опоздал бы.
 */
function RoleButton({ role, onClick }: { role: string | undefined; onClick(): void }): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const stop = (e: Event): void => e.stopPropagation()
    el.addEventListener('pointerdown', stop)
    return () => el.removeEventListener('pointerdown', stop)
  }, [])
  return (
    <button
      ref={ref}
      type="button"
      className={role ? 'node-term__role' : 'node-term__role node-term__role--empty'}
      data-testid="terminal-role"
      title={role ? `Роль: ${role} — изменить` : 'Задать роль — её видят агенты'}
      onClick={onClick}
    >
      {role ?? '+ роль'}
    </button>
  )
}

export function TerminalNodeLowDetail(): React.JSX.Element {
  return <div className="node-lod node-lod--term" />
}
