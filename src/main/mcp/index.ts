import { app, ipcMain, session, webContents, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { WEB_PARTITION } from '@shared/app'
import { COMMANDS } from '@shared/commands'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from '../settings-store'
import type { Workspace } from '../workspace'
import {
  isTerminalRunning,
  terminalIdleMs,
  listTerminals,
  onTerminalStopped,
  setTerminalEnvProvider,
  writeTerminal
} from '../terminal'
import { humanTyping } from '../human-typing'
import { CanvasBridge } from './bridge'
import { startMcpHttp, type McpHttpServer } from './http'
import { McpHandler } from './protocol'
import { TokenRegistry } from './tokens'
import { isHelperWindow } from '../helper-windows'
import { renderSnapshot } from '../snapshot'
import { profileWindow } from './perf'
import { captureWeb } from './web-capture'
import { claudeWrapperScript, launcherScript, stableExecPath } from './launchers'
import type { AgentMcp } from '@shared/agent-plugin'
import type { AgentLauncher } from '../agents/launcher'
import { LetterPost } from './letters'
import { greetingText } from './greeting'
import changelog from '../../../CHANGELOG.md?raw'
import { buildTools, deliverFromPortal, notifyAgents, serverInfo, timerLetter, type ToolDeps } from './tools'
import { TimerQueue } from './timers'
import { MessageBox } from './messages'
import type { PortalDelivery, PortalIncoming } from '@shared/portal'
import type { AgentNotices, TimerTick } from '@shared/api'

/**
 * MCP-сервер холста для агентов, живущих в его же терминалах. Каждый терминал получает
 * в окружение адрес, свой токен и id своей ноды — агент сразу знает, где он запущен.
 * Для агентов, которым нужен stdio, рядом лежит `cnv-mcp` (он в PATH терминала), а
 * для Claude Code — готовый `--mcp-config`.
 */

export interface McpContext {
  settings: SettingsStore
  workspace: Workspace
  getWindow: () => BrowserWindow | null
  /** Какие агенты бывают — для create_node kind=agent и list_agent_types. */
  agentPlugins: () => { id: string; label: string }[]
  agentSessions: NonNullable<ToolDeps['agentSessions']>
  /** Живые агенты: канал, свой способ доставки писем, черновик по экрану. */
  launcher: Pick<
    AgentLauncher,
    'usesChannel' | 'deliver' | 'inputDraft' | 'resumed' | 'starting' | 'startupAnswer'
  >
}

export interface McpService {
  url: string
  /** Файл для `claude --mcp-config`: агенты-ноды запускаются с ним. */
  claudeConfig: string
  /** Как плагину агента подключить холст: HTTP с токеном из env или stdio-мост. */
  agent: AgentMcp
  /** Письмо с той стороны портала — агенту на этой. */
  deliverPortal(incoming: PortalIncoming): Promise<PortalDelivery>
  /** Агентам — что поменялось в их связях и цветах: письмом от cnv, как обычная почта. */
  notify(batch: AgentNotices): void
  /** Тик таймера: письмо агентам, как только каждый освободится. */
  timerTick(tick: TimerTick): void
  stop(): Promise<void>
}

/** Пауза перед приветствием после переподключения агента. */
const GREETING_DELAY_MS = 3000

const writePrivate = (file: string, text: string, mode = 0o600): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { encoding: 'utf8', mode })
  fs.chmodSync(file, mode)
}

/**
 * Скрипт моста копируется из сборки (в пакете — из asar) в стабильную папку: из точки
 * монтирования AppImage он пропадёт вместе с выходом cnv. Зависимостей у него нет — один файл.
 */
function installStdioScript(binDir: string): string {
  const target = path.join(binDir, 'mcp-stdio.cjs')
  writePrivate(target, fs.readFileSync(path.join(__dirname, 'mcp-stdio.js'), 'utf8'))
  return target
}

export async function startMcp(ctx: McpContext): Promise<McpService | null> {
  if (!ctx.settings.settings.mcp.enabled) return null

  const tokens = new TokenRegistry()
  const bridge = new CanvasBridge(() => ctx.getWindow()?.webContents ?? null)
  ipcMain.on(IPC.agentReady, () => bridge.setReady(true))

  const dir = path.join(app.getPath('userData'), 'mcp')
  const binDir = path.join(dir, 'bin')
  const discovery = path.join(dir, 'server.json')
  const claudeConfig = path.join(dir, 'claude-mcp.json')
  const script = installStdioScript(binDir)
  const exe = stableExecPath(process.env, process.execPath)
  let server: McpHttpServer | null = null

  const messages = new MessageBox(path.join(dir, 'messages.jsonl'))
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const post = new LetterPost({
    isRunning: isTerminalRunning,
    write: writeTerminal,
    sleep,
    readScreen: async (nodeId) =>
      (await bridge.call('readTerminal', { id: nodeId, lines: 40, typedOnly: true }).catch(() => null))
        ?.text ?? null,
    inputDraft: (nodeId, screen) => ctx.launcher.inputDraft(nodeId, screen),
    humanTyping,
    usesChannel: (nodeId) => ctx.launcher.usesChannel(nodeId),
    hasStream: (nodeId) => server?.hasStream(nodeId) ?? false,
    push: (nodeId, message) => server?.push(nodeId, message) ?? 0,
    deliver: (nodeId, letter) => ctx.launcher.deliver(nodeId, letter)
  })
  // Стартовый диалог агента, который вызвал сам cnv (подтверждение канала у Claude Code):
  // первую минуту после запуска смотрим на экран и жмём за человека.
  let answering = false
  const startupTimer = setInterval(() => {
    if (answering) return
    const ids = ctx.launcher.starting()
    if (!ids.length) return
    answering = true
    void (async () => {
      for (const id of ids) {
        // Весь экран: диалог рисуется сверху, а у высокого терминала ниже — пустые строки.
        const screen = await bridge.call('readTerminal', { id, lines: 200 }).catch(() => null)
        const keys = screen?.text ? ctx.launcher.startupAnswer(id, screen.text) : null
        if (keys) writeTerminal(id, keys)
      }
    })().finally(() => {
      answering = false
    })
  }, 1000)
  startupTimer.unref?.()
  const deps: ToolDeps = {
    messages,
    post,
    call: (method, params, timeoutMs) => bridge.call(method, params, timeoutMs),
    context: () => ({
      appVersion: app.getVersion(),
      canvasFile: ctx.settings.canvasPath,
      workspaceRoot: ctx.workspace.rootPath,
      mcpUrl: server?.url ?? ''
    }),
    terminals: {
      list: listTerminals,
      isRunning: isTerminalRunning,
      write: writeTerminal,
      idleMs: terminalIdleMs
    },
    attachmentsDir: path.join(dir, 'attachments'),
    importFile: (abs) => ctx.workspace.importPath(abs, ctx.settings.settings.workspace.attachmentsDir),
    snapshot: (source, scale) => renderSnapshot(source, scale),
    perf: async (seconds) => {
      const win = ctx.getWindow()
      if (!win || win.isDestroyed()) throw new Error('окна cnv нет')
      return profileWindow(win, seconds, path.join(dir, 'profiles'))
    },
    screenshot: async () => {
      const win = ctx.getWindow()
      if (!win || win.isDestroyed()) return null
      const image = await win.webContents.capturePage()
      return image.isEmpty() ? null : image.toPNG().toString('base64')
    },
    web: {
      evaluate: (id, code) => {
        const guest = webContents.fromId(id)
        if (!guest || guest.isDestroyed()) return Promise.reject(new Error('страница закрылась'))
        return guest.executeJavaScript(code, true)
      },
      capture: async (id, opts) => {
        const guest = webContents.fromId(id)
        if (!guest || guest.isDestroyed()) return null
        try {
          return await captureWeb(guest, opts)
        } catch {
          // Отладчик занят (открыт DevTools) — снимаем как есть.
          const image = await guest.capturePage()
          return image.isEmpty() ? null : image.toPNG().toString('base64')
        }
      },
      // Та же сессия, что у веб-нод: куки и логины человека, но без страницы на холсте.
      fetch: async (url, init) => {
        const res = await session.fromPartition(WEB_PARTITION).fetch(url, {
          method: init.method,
          headers: init.headers,
          ...(init.body !== undefined ? { body: init.body } : {})
        })
        const headers: Record<string, string> = {}
        res.headers.forEach((value, key) => {
          headers[key] = value
        })
        return { status: res.status, url: res.url, headers, body: Buffer.from(await res.arrayBuffer()) }
      }
    },
    commands: COMMANDS,
    agentPlugins: () => ctx.agentPlugins(),
    agentSessions: (plugin, cwd) => ctx.agentSessions(plugin, cwd),
    sleep
  }

  // Агенту с каналом, когда он впервые за этот запуск cnv открыл поток: «cnv перезапущен»
  // (и что нового, если версия сменилась). Небольшая пауза — Claude Code успевает
  // зарегистрировать канал после подключения.
  const version = app.getVersion()
  const versionFile = path.join(dir, 'last-version')
  let previous: string | null = null
  try {
    previous = fs.readFileSync(versionFile, 'utf8').trim() || null
  } catch {
    // Первый запуск с этой фичей.
  }
  writePrivate(versionFile, version)
  const greeted = new Set<string>()
  function greet(nodeId: string): void {
    // Новому агенту «перезапущен» ни к чему — только продолжившим свой разговор.
    if (greeted.has(nodeId) || !ctx.launcher.usesChannel(nodeId) || !ctx.launcher.resumed(nodeId)) return
    greeted.add(nodeId)
    setTimeout(() => {
      server?.push(nodeId, {
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: { content: greetingText(version, previous, changelog), meta: { kind: 'restart' } }
      })
    }, GREETING_DELAY_MS)
  }

  const handler = new McpHandler(serverInfo(deps), buildTools(deps))
  try {
    server = await startMcpHttp({
      handler,
      authenticate: (token) => tokens.resolve(token),
      onStream: greet,
      port: ctx.settings.settings.mcp.port
    })
  } catch (error) {
    console.error('[mcp] сервер не поднялся:', error)
    return null
  }
  const url = server.url

  writePrivate(discovery, JSON.stringify({ url, token: tokens.appToken, pid: process.pid }, null, 2))
  const launcher = launcherScript({
    exe,
    live: process.execPath,
    script,
    discovery,
    platform: process.platform
  })
  const launcherFile = path.join(binDir, launcher.file)
  writePrivate(launcherFile, launcher.content, 0o700)
  // Агентам — через обёртку: она берёт электрон живого cnv, а не `.AppImage` (см. LauncherPaths.live).
  const stdioBridge =
    process.platform === 'win32'
      ? { command: exe, args: [script, '--discovery', discovery], env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { command: launcherFile, args: [] as string[], env: {} as Record<string, string> }
  if (process.platform !== 'win32') {
    const wrapper = claudeWrapperScript()
    writePrivate(path.join(binDir, wrapper.file), wrapper.content, 0o700)
  }
  writePrivate(
    claudeConfig,
    JSON.stringify(
      {
        mcpServers: {
          cnv: {
            type: 'stdio',
            ...stdioBridge
          }
        }
      },
      null,
      2
    )
  )

  setTerminalEnvProvider((nodeId, name, role) => ({
    CNV_APP: 'cnv',
    CNV_NODE_ID: nodeId,
    ...(name ? { CNV_TERMINAL_NAME: name } : {}),
    ...(role ? { CNV_ROLE: role } : {}),
    CNV_MCP_URL: url,
    CNV_MCP_TOKEN: tokens.issue(nodeId),
    CNV_MCP_CONFIG: claudeConfig,
    CNV_CANVAS_FILE: ctx.settings.canvasPath ?? '',
    CNV_WORKSPACE: ctx.workspace.rootPath ?? '',
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  }))
  const offStopped = onTerminalStopped((nodeId) => tokens.revoke(nodeId))

  const watchWindow = (win: BrowserWindow | null): void => {
    // Скрытые служебные окна (снимки нод) — не холст: их навигация мост не сбрасывает.
    if (!win || isHelperWindow(win)) return
    // Именно перезагрузка самого холста: did-start-loading прилетает и от загрузки <webview>.
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) bridge.setReady(false)
    })
  }
  watchWindow(ctx.getWindow())
  app.on('browser-window-created', (_e, win) => watchWindow(win))

  const timers = new TimerQueue({
    idleMs: (nodeId) => (isTerminalRunning(nodeId) ? terminalIdleMs(nodeId) : null),
    deliver: (nodeId, tick) => timerLetter(deps, messages, nodeId, tick)
  })

  return {
    url,
    claudeConfig,
    deliverPortal: (incoming) => deliverFromPortal(deps, messages, incoming),
    notify: (batch) => notifyAgents(deps, messages, batch),
    timerTick: (tick) => timers.fire(tick),
    agent: {
      url,
      tokenEnv: 'CNV_MCP_TOKEN',
      forwardEnv: ['CNV_MCP_URL', 'CNV_MCP_TOKEN', 'CNV_NODE_ID'],
      stdio: stdioBridge,
      configFile: claudeConfig,
      serverName: 'cnv',
      channels: false
    },
    stop: async () => {
      post.stop()
      timers.stop()
      clearInterval(startupTimer)
      offStopped()
      setTerminalEnvProvider(() => ({}))
      try {
        fs.rmSync(discovery, { force: true })
      } catch {
        // Не страшно: stdio-мост увидит отказ в соединении и ответит «офлайн».
      }
      await server?.close()
    }
  }
}
