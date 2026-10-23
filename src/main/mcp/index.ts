import { app, ipcMain, webContents, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { COMMANDS } from '@shared/commands'
import { IPC } from '@shared/ipc'
import type { SettingsStore } from '../settings-store'
import type { Workspace } from '../workspace'
import {
  isTerminalRunning,
  listTerminals,
  onTerminalStopped,
  setTerminalEnvProvider,
  writeTerminal
} from '../terminal'
import { CanvasBridge } from './bridge'
import { startMcpHttp, type McpHttpServer } from './http'
import { McpHandler } from './protocol'
import { TokenRegistry } from './tokens'
import { buildTools, serverInfo, type ToolDeps } from './tools'

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
}

export interface McpService {
  url: string
  /** Файл для `claude --mcp-config`: агенты-ноды запускаются с ним. */
  claudeConfig: string
  stop(): Promise<void>
}

const writePrivate = (file: string, text: string, mode = 0o600): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { encoding: 'utf8', mode })
  fs.chmodSync(file, mode)
}

/** Собранный `mcp-stdio.js`. Из asar его node-режим электрона читать не обязан — берём распакованный. */
function stdioScript(): string {
  const inAsar = path.join(__dirname, 'mcp-stdio.js')
  const unpacked = inAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  return fs.existsSync(unpacked) ? unpacked : inAsar
}

/** `cnv-mcp` в PATH терминала: stdio-мост для любого агента. */
function writeLaunchers(binDir: string, script: string, discovery: string): void {
  const exe = process.execPath
  if (process.platform === 'win32') {
    writePrivate(
      path.join(binDir, 'cnv-mcp.cmd'),
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" --discovery "${discovery}" %*\r\n`,
      0o700
    )
    return
  }
  const q = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`
  writePrivate(
    path.join(binDir, 'cnv-mcp'),
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(exe)} ${q(script)} --discovery ${q(discovery)} "$@"\n`,
    0o700
  )
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
  const script = stdioScript()
  let server: McpHttpServer | null = null

  const deps: ToolDeps = {
    call: (method, params) => bridge.call(method, params),
    context: () => ({
      appVersion: app.getVersion(),
      canvasFile: ctx.settings.canvasPath,
      workspaceRoot: ctx.workspace.rootPath,
      mcpUrl: server?.url ?? ''
    }),
    terminals: { list: listTerminals, isRunning: isTerminalRunning, write: writeTerminal },
    importFile: async (abs) =>
      (await ctx.workspace.importPath(abs, ctx.settings.settings.workspace.attachmentsDir)).relPath,
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
      capture: async (id) => {
        const guest = webContents.fromId(id)
        if (!guest || guest.isDestroyed()) return null
        const image = await guest.capturePage()
        return image.isEmpty() ? null : image.toPNG().toString('base64')
      }
    },
    commands: COMMANDS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }

  const handler = new McpHandler(serverInfo(deps), buildTools(deps))
  try {
    server = await startMcpHttp({
      handler,
      authenticate: (token) => tokens.resolve(token),
      port: ctx.settings.settings.mcp.port
    })
  } catch (error) {
    console.error('[mcp] сервер не поднялся:', error)
    return null
  }
  const url = server.url

  writePrivate(discovery, JSON.stringify({ url, token: tokens.appToken, pid: process.pid }, null, 2))
  writeLaunchers(binDir, script, discovery)
  writePrivate(
    claudeConfig,
    JSON.stringify(
      {
        mcpServers: {
          cnv: {
            type: 'stdio',
            command: process.execPath,
            args: [script, '--discovery', discovery],
            env: { ELECTRON_RUN_AS_NODE: '1' }
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
    // Именно перезагрузка самого холста: did-start-loading прилетает и от загрузки <webview>.
    win?.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) bridge.setReady(false)
    })
  }
  watchWindow(ctx.getWindow())
  app.on('browser-window-created', (_e, win) => watchWindow(win))

  return {
    url,
    claudeConfig,
    stop: async () => {
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
