import { app, type WebContents } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import * as pty from 'node-pty'
import { IPC } from '@shared/ipc'

/**
 * Настоящий PTY, а не пайп: без него нет ни цветов, ни `vim`, ни `htop`, ни Ctrl+C.
 * Процессы живут ровно пока живёт приложение — держать их дольше значит писать свой
 * tmux, а это другая задача. Переживает перезапуск только рабочая папка.
 */

/** Как часто спрашивать у процесса его папку: `cd` надо донести до документа. */
const CWD_POLL_MS = 2000
/** Пауза между первым выводом шелла и вводом команды агента. */
const INPUT_DELAY_MS = 250

interface Session {
  term: pty.IPty
  cwd: string
  shell: string
}

const sessions = new Map<string, Session>()
let cwdTimer: ReturnType<typeof setInterval> | null = null

/**
 * Чем дополнить окружение процесса: сюда MCP кладёт адрес, токен и id ноды, чтобы
 * агент внутри терминала знал, где он запущен. Хук, а не импорт, — без цикла модулей.
 */
type EnvProvider = (nodeId: string, name: string | undefined) => Record<string, string>
type StopListener = (nodeId: string) => void
let envProvider: EnvProvider = () => ({})
const stopListeners = new Set<StopListener>()

export function setTerminalEnvProvider(provider: EnvProvider): void {
  envProvider = provider
}

/** Процесс ноды умер или убит — токен агента пора отзывать. */
export function onTerminalStopped(listener: StopListener): () => void {
  stopListeners.add(listener)
  return () => stopListeners.delete(listener)
}

export interface TerminalSessionInfo {
  nodeId: string
  pid: number
  shell: string
  cwd: string
}

export function listTerminals(): TerminalSessionInfo[] {
  return [...sessions].map(([nodeId, s]) => ({ nodeId, pid: s.term.pid, shell: s.shell, cwd: s.cwd }))
}

export const isTerminalRunning = (nodeId: string): boolean => sessions.has(nodeId)

export const defaultShell = (): string => process.env.SHELL || '/bin/sh'

/** Папка процесса берётся у ядра: шелл про свой `cd` никому не сообщает. */
function currentCwd(pid: number): string | null {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

function pollCwd(host: WebContents): void {
  for (const [id, session] of sessions) {
    const now = currentCwd(session.term.pid)
    if (!now || now === session.cwd) continue
    session.cwd = now
    host.send(IPC.terminalCwd, { nodeId: id, cwd: now })
  }
}

export function startTerminal(
  host: WebContents,
  options: {
    nodeId: string
    shell?: string
    cwd?: string
    cols: number
    rows: number
    name?: string
    /** Что напечатать в шелл, как только он ожил (запуск агента). */
    input?: string
  }
): { pid: number; shell: string; cwd: string } {
  stopTerminal(options.nodeId)

  const shell = options.shell || defaultShell()
  const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : os.homedir()
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: Math.max(options.cols, 1),
    rows: Math.max(options.rows, 1),
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...envProvider(options.nodeId, options.name)
    }
  })

  sessions.set(options.nodeId, { term, cwd, shell })

  let pendingInput = options.input
  term.onData((data) => {
    if (!host.isDestroyed()) host.send(IPC.terminalData, { nodeId: options.nodeId, data })
    if (pendingInput === undefined) return
    // Первый вывод — шелл ожил; ещё миг на rc-файлы и промпт, иначе ввод съедят.
    const input = pendingInput
    pendingInput = undefined
    setTimeout(() => {
      if (sessions.get(options.nodeId)?.term === term) term.write(`${input}\r`)
    }, INPUT_DELAY_MS)
  })
  term.onExit(({ exitCode, signal }) => {
    // Сессию могли уже заменить перезапуском — тогда этот выход не наш.
    if (sessions.get(options.nodeId)?.term !== term) return
    sessions.delete(options.nodeId)
    for (const l of stopListeners) l(options.nodeId)
    if (!host.isDestroyed()) host.send(IPC.terminalExit, { nodeId: options.nodeId, exitCode, signal })
  })

  if (!cwdTimer) cwdTimer = setInterval(() => pollCwd(host), CWD_POLL_MS)
  return { pid: term.pid, shell, cwd }
}

export function writeTerminal(nodeId: string, data: string): void {
  sessions.get(nodeId)?.term.write(data)
}

export function resizeTerminal(nodeId: string, cols: number, rows: number): void {
  sessions.get(nodeId)?.term.resize(Math.max(cols, 1), Math.max(rows, 1))
}

export function stopTerminal(nodeId: string): void {
  const session = sessions.get(nodeId)
  if (!session) return
  sessions.delete(nodeId)
  for (const l of stopListeners) l(nodeId)
  session.term.kill()
}

export function stopAllTerminals(): void {
  for (const id of [...sessions.keys()]) stopTerminal(id)
  if (cwdTimer) {
    clearInterval(cwdTimer)
    cwdTimer = null
  }
}

app.on('will-quit', stopAllTerminals)
