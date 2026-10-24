import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import { terminalSpec, withAgentSession, withTerminalSpec, withoutAgentPrompt } from '@core/terminal'
import { useCanvasEnv } from '@renderer/canvas/env'
import type { NodeViewProps } from './registry'
import { onTerminalRestart, registerTerminal } from './terminal-registry'
import { HeaderButton } from './HeaderButton'
import { NodeHeaderActions } from './NodeHeaderActions'
import { unscaleTerminalMouse } from './terminal-mouse'
import { agentLabel, useAgentPlugins } from '@renderer/workspace/useAgentPlugins'

/** Шрифт задаётся в настройках, а пропорции знака берём у той же гарнитуры, что и код. */
const FONT = "'Iosevka', 'JetBrains Mono', ui-monospace, monospace"

export function TerminalNodeView({ node, active }: NodeViewProps<DocNode>): React.JSX.Element {
  const { store, settings, editIdentity } = useCanvasEnv()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [exited, setExited] = useState<number | null>(null)
  const [shell, setShell] = useState('')
  // Сменили сессию агента — процесс перезапускается и продолжает уже её.
  const [generation, setGeneration] = useState(0)
  useEffect(() => onTerminalRestart(node.id, () => setGeneration((g) => g + 1)), [node.id])

  const fontSize = settings.terminal.fontSize
  const spec = terminalSpec(node)
  const cwd = spec?.cwd
  const name = spec?.name
  const role = spec?.role
  const agentSpec = spec?.agent
  const sessionId = agentSpec?.sessionId
  const plugins = useAgentPlugins()
  /** Что агент знает о себе: имя и роль из промпта запуска или из последнего уведомления. */
  const known = useRef<{ name: string | undefined; role: string | undefined } | null>(null)

  // Имя или роль сменили у работающего агента — промпт запуска уже не про него: сообщаем
  // ему прямо в чат, как это сделал бы человек. Вставкой, чтобы переводы строк не жали Enter.
  useEffect(() => {
    const was = known.current
    if (!was || exited !== null || (was.name === name && was.role === role)) return
    const lines: string[] = []
    if (was.name !== name && name) lines.push(`Тебя переименовали: теперь ты «${name}».`)
    if (was.role !== role) lines.push(role ? `Твоя роль теперь: ${role}.` : 'Роль с тебя сняли.')
    known.current = { name, role }
    if (lines.length === 0) return
    const text = `[cnv: ${lines.join(' ')} Это сообщение от холста, отвечать на него не нужно.]`
    window.api.terminal.write(node.id, `\x1b[200~${text}\x1b[201~`)
    // Enter — отдельно и чуть позже: агенту нужен миг переварить вставку.
    setTimeout(() => window.api.terminal.write(node.id, '\r'), 150)
  }, [name, role, exited, node.id])

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
    // С этими именем и ролью агент запущен: они у него в системном промпте.
    known.current = agent ? { name: startSpec?.name, role: startSpec?.role } : null
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
  }, [node.id, fontSize, store, generation])

  useEffect(() => {
    if (active) termRef.current?.focus()
    else termRef.current?.blur()
  }, [active])

  const title = cwd ?? ''

  return (
    <div className={active ? 'node-term node-term--active' : 'node-term'}>
      <div className="node-term__bar" data-testid="terminal-bar">
        {name && (
          <HeaderButton
            className="node-term__name"
            testId="terminal-name"
            title={`${agentSpec ? `сессия ${sessionId || 'ещё не начата'}` : node.id} — клик: переименовать`}
            onClick={() => editIdentity(node.id, 'name')}
          >
            {agentSpec ? '✦ ' : ''}
            {name}
          </HeaderButton>
        )}
        <HeaderButton
          className={role ? 'node-term__role' : 'node-term__role node-term__role--empty'}
          testId="terminal-role"
          title={role ? `Роль: ${role} — изменить` : 'Задать роль — её видят агенты'}
          onClick={() => editIdentity(node.id, 'role')}
        >
          {role ?? '+ роль'}
        </HeaderButton>
        <NodeHeaderActions node={node} />
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

export function TerminalNodeLowDetail(): React.JSX.Element {
  return <div className="node-lod node-lod--term" />
}
