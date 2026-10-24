import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { replaceNodes, type DocNode } from '@core/document'
import { patchNodes } from '@core/ops'
import { collapseAgent, expandAgent } from '@core/agent-mini'
import type { AgentStatus } from '@core/terminal'
import { terminalSpec, withAgentSession, withTerminalSpec, withoutAgentPrompt } from '@core/terminal'
import { useCanvasEnv } from '@renderer/canvas/env'
import type { NodeViewProps } from './registry'
import { onTerminalRestart, registerTerminal } from './terminal-registry'
import { HeaderButton } from './HeaderButton'
import { NodeHeaderActions } from './NodeHeaderActions'
import { unscaleTerminalMouse } from './terminal-mouse'
import { agentLabel, useAgentPlugins } from '@renderer/workspace/useAgentPlugins'

/** Вывод был не позже этого — агент занят: крутит спиннер, печатает ответ. */
const BUSY_MS = 2000

/** Шрифт задаётся в настройках, а пропорции знака берём у той же гарнитуры, что и код. */
const FONT = "'Iosevka', 'JetBrains Mono', ui-monospace, monospace"

export function TerminalNodeView(props: NodeViewProps<DocNode>): React.JSX.Element {
  const { snapshot } = useCanvasEnv()
  return snapshot ? (
    <TerminalSnapshot node={props.node} text={snapshot.terminals[props.node.id] ?? ''} />
  ) : (
    <TerminalNodeLive {...props} />
  )
}

/** Терминал на снимке: та же шапка, а вместо живого xterm — текст его экрана. */
function TerminalSnapshot({ node, text }: { node: DocNode; text: string }): React.JSX.Element {
  const spec = terminalSpec(node)
  const plugins = useAgentPlugins()
  return (
    <div className="node-term">
      <div className="node-term__bar">
        {spec?.name && (
          <span className="node-term__name">
            {spec.agent ? '✦ ' : ''}
            {spec.name}
          </span>
        )}
        {spec?.role && <span className="node-term__role">{spec.role}</span>}
        <span className="node-term__shell">
          {spec?.agent ? agentLabel(plugins, spec.agent.plugin ?? 'claude') : 'терминал'}
        </span>
        <span className="node-term__cwd">{spec?.cwd ?? ''}</span>
      </div>
      <pre className="node-term__screen node-term__snapshot">{text}</pre>
    </div>
  )
}

function TerminalNodeLive({ node, active }: NodeViewProps<DocNode>): React.JSX.Element {
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
  const collapsed = spec?.collapsed
  const icon = spec?.icon
  const status = spec?.status
  /** Когда терминал последний раз что-то вывел — по этому видно, занят ли агент. */
  const lastOutput = useRef(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!collapsed) return
    const tick = (): void => setBusy(Date.now() - lastOutput.current < BUSY_MS)
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [collapsed])
  // Двойной клик по кружку активирует ноду — а с агентом говорят в развёрнутом виде.
  useEffect(() => {
    if (!active || !collapsed) return
    store.mutate('развернуть агента', (doc) =>
      replaceNodes(doc, new Map(doc.nodes.filter((n) => n.id === node.id).map((n) => [n.id, expandAgent(n)])))
    )
  }, [active, collapsed, store, node.id])
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
      if (e.nodeId !== node.id) return
      term.write(e.data)
      lastOutput.current = Date.now()
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
    // Shift+Enter — новая строка в поле ввода агента, а не отправка: шлём перевод строки
    // (Ctrl+J), его как «новая строка» понимают Claude Code, Codex и OpenCode. xterm сам
    // отдал бы обычный Enter (\r).
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return true
      if (e.type === 'keydown') window.api.terminal.write(node.id, '\n')
      return false
    })

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

  // Свёрнутый: терминал остаётся в DOM прежнего размера, только невидимый — xterm и PTY
  // не замечают сворачивания, размер строк у агента не меняется.
  return (
    <div className={collapsed ? 'node-term-host node-term-host--collapsed' : 'node-term-host'}>
      <div
        className={active ? 'node-term node-term--active' : 'node-term'}
        style={collapsed ? { width: collapsed.width, height: collapsed.height } : undefined}
        aria-hidden={collapsed ? true : undefined}
      >
        <div className="node-term__bar" data-testid="terminal-bar">
          {name && (
            <HeaderButton
              className="node-term__name"
              testId="terminal-name"
              title={`${agentSpec ? `сессия ${sessionId || 'ещё не начата'}` : node.id} — клик: переименовать`}
              onClick={() => editIdentity(node.id, 'name')}
            >
              {agentSpec ? `${icon ?? '✦'} ` : ''}
              {name}
            </HeaderButton>
          )}
          {status && <StatusChip status={status} />}
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
              {agentSpec.model ? ` · ${agentSpec.model}` : ''}
            </span>
          ) : (
            <span className="node-term__shell">{shell || 'терминал'}</span>
          )}
          <span className="node-term__cwd" title={cwd}>
            {title}
          </span>
          {exited !== null && <span className="node-term__dead">завершён</span>}
          {agentSpec && (
            <button
              type="button"
              className="node-header-action node-term__collapse"
              title="Свернуть в кружок: агент работает дальше, двойной клик — развернуть"
              data-testid="header-collapse"
              onClick={() =>
                store.mutate('свернуть агента', (doc) =>
                  replaceNodes(
                    doc,
                    new Map(doc.nodes.filter((n) => n.id === node.id).map((n) => [n.id, collapseAgent(n)]))
                  )
                )
              }
            >
              ◉
            </button>
          )}
        </div>
        <div className="node-term__screen" ref={hostRef} data-testid="terminal-screen" />
        {!active && <div className="node-term__shield" data-testid="terminal-shield" />}
      </div>
      {collapsed && (
        <AgentMini name={name} role={role} icon={icon} status={status} busy={busy} dead={exited !== null} />
      )}
    </div>
  )
}

function StatusChip({ status }: { status: AgentStatus }): React.JSX.Element {
  const parts = [status.progress !== undefined ? `${Math.round(status.progress)}%` : '', status.text ?? '']
  return (
    <span
      className="node-term__status"
      title={`Статус от агента, ${new Date(status.at).toLocaleTimeString()}`}
      data-testid="terminal-status"
    >
      {parts.filter(Boolean).join(' · ')}
    </span>
  )
}

/** «Озорная Настя» → «ОН»; одно слово — две первые буквы. */
function initials(name: string | undefined): string {
  if (!name) return '✦'
  const words = name.split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => [...w][0]) : [...(words[0] ?? '')].slice(0, 2)
  return letters.join('').toUpperCase()
}

const RING_R = 52
const RING_LEN = 2 * Math.PI * RING_R

/** Свёрнутый агент: значок в кружке, по краю — прогресс или «занят», ниже имя и роль. */
function AgentMini(props: {
  name: string | undefined
  role: string | undefined
  icon: string | undefined
  status: AgentStatus | undefined
  busy: boolean
  dead: boolean
}): React.JSX.Element {
  const { name, role, icon, status, busy, dead } = props
  const progress = status?.progress
  const state = dead ? 'dead' : busy ? 'busy' : 'idle'
  const hint = [
    name,
    role,
    dead ? 'процесс завершён' : busy ? 'работает' : 'ждёт',
    status
      ? [progress !== undefined ? `${Math.round(progress)}%` : '', status.text ?? '']
          .filter(Boolean)
          .join(' · ')
      : '',
    'двойной клик — развернуть'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <div className={`node-mini node-mini--${state}`} title={hint} data-testid="agent-mini" data-state={state}>
      <div className="node-mini__circle">
        <svg className="node-mini__ring" viewBox="0 0 120 120" aria-hidden>
          <circle className="node-mini__track" cx="60" cy="60" r={RING_R} />
          {progress !== undefined && (
            <circle
              className="node-mini__progress"
              cx="60"
              cy="60"
              r={RING_R}
              strokeDasharray={`${(RING_LEN * progress) / 100} ${RING_LEN}`}
            />
          )}
          {busy && !dead && (
            <circle
              className="node-mini__spin"
              cx="60"
              cy="60"
              r={RING_R}
              strokeDasharray={`${RING_LEN / 5} ${RING_LEN}`}
            />
          )}
        </svg>
        <span className="node-mini__icon">{icon ?? initials(name)}</span>
        {progress !== undefined && <span className="node-mini__pct">{Math.round(progress)}%</span>}
      </div>
      <div className="node-mini__name">{name ?? 'агент'}</div>
      {(status?.text ?? role) && <div className="node-mini__role">{status?.text ?? role}</div>}
    </div>
  )
}

export function TerminalNodeLowDetail(): React.JSX.Element {
  return <div className="node-lod node-lod--term" />
}
