import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { FILE_PROTOCOL } from '@shared/app'
import { IPC } from '@shared/ipc'
import type {
  TerminalInfo,
  AppApi,
  ClipboardPayload,
  CanvasFileContent,
  DeepPartial,
  ExternalChange,
  GuestWindowOpen,
  ImportedFile,
  TextFileContent,
  TextFileWrite,
  Unsubscribe,
  WorkspaceInfo,
  WriteResult
} from '@shared/api'
import type { AgentRequest } from '@shared/agent'
import type { AgentPluginsState, AgentSessionInfo } from '@shared/agent-plugin'
import type { Settings } from '@shared/settings'
import type { SnapshotPayload } from '@shared/snapshot'
import type { DeviceIdentityView, PortalDelivery } from '@shared/portal'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AppApi = {
  platform: {
    os: process.platform,
    isLinux: process.platform === 'linux',
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32'
  },
  workspace: {
    current: () => ipcRenderer.invoke(IPC.workspaceCurrent) as Promise<WorkspaceInfo | null>,
    onOpened: (cb) => on<[WorkspaceInfo | null]>(IPC.workspaceOpened, cb)
  },
  canvas: {
    currentFile: () => ipcRenderer.invoke(IPC.canvasCurrent) as Promise<string | null>,
    chooseFile: () => ipcRenderer.invoke(IPC.canvasChooseFile) as Promise<string | null>,
    read: (relPath) => ipcRenderer.invoke(IPC.canvasRead, relPath) as Promise<CanvasFileContent>,
    write: (relPath, text) => ipcRenderer.invoke(IPC.canvasWrite, relPath, text) as Promise<WriteResult>,
    onExternalChange: (cb) => on<[ExternalChange]>(IPC.canvasExternalChange, cb),
    onOpenRequest: (cb) => on<[string]>(IPC.canvasOpenRequest, cb)
  },
  attachments: {
    importPath: (sourcePath) =>
      ipcRenderer.invoke(IPC.attachmentsImportPath, sourcePath) as Promise<ImportedFile>,
    importBytes: (fileName, bytes) =>
      ipcRenderer.invoke(IPC.attachmentsImportBytes, fileName, bytes) as Promise<ImportedFile>,
    refresh: (relPath, source) =>
      ipcRenderer.invoke(IPC.attachmentsRefresh, relPath, source) as Promise<{
        updated: boolean
        missing: boolean
      }>
  },
  files: {
    url: (relPath) => `${FILE_PROTOCOL}://workspace/${relPath.split('/').map(encodeURIComponent).join('/')}`,
    stat: (relPath) =>
      ipcRenderer.invoke(IPC.filesStat, relPath) as Promise<{ size: number; mtimeMs: number } | null>,
    readText: (relPath) => ipcRenderer.invoke(IPC.filesReadText, relPath) as Promise<string | null>,
    openInSystem: (relPath) => ipcRenderer.invoke(IPC.filesOpenInSystem, relPath) as Promise<void>,
    choose: (filters) => ipcRenderer.invoke(IPC.filesChoose, filters) as Promise<string[]>,
    pathForDrop: (file) => webUtils.getPathForFile(file),
    preview: (relPath, maxSide) =>
      ipcRenderer.invoke(IPC.filesPreview, relPath, maxSide) as Promise<string | null>,
    imageSize: (relPath) =>
      ipcRenderer.invoke(IPC.filesImageSize, relPath) as Promise<{ width: number; height: number } | null>,
    onChanged: (cb) => on<[string]>(IPC.filesChanged, cb),
    track: (files) => ipcRenderer.send(IPC.filesTrack, files),
    readDoc: (relPath) => ipcRenderer.invoke(IPC.filesReadDoc, relPath) as Promise<TextFileContent | null>,
    writeDoc: (relPath, text, baseMtimeMs, force) =>
      ipcRenderer.invoke(IPC.filesWriteDoc, relPath, text, baseMtimeMs, force) as Promise<TextFileWrite>
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, url) as Promise<void>
  },
  clipboard: {
    writeCanvas: (fragment) => ipcRenderer.invoke(IPC.clipboardWriteCanvas, fragment) as Promise<void>,
    writeText: (text) => ipcRenderer.invoke(IPC.clipboardWriteText, text) as Promise<void>,
    read: () => ipcRenderer.invoke(IPC.clipboardRead) as Promise<ClipboardPayload>
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
    patch: (patch: DeepPartial<Settings>) =>
      ipcRenderer.invoke(IPC.settingsPatch, patch) as Promise<Settings>,
    onChanged: (cb) => on<[Settings]>(IPC.settingsChanged, cb)
  },
  snapshots: {
    capture: (webContentsId) =>
      ipcRenderer.invoke(IPC.snapshotsCapture, webContentsId) as Promise<string | null>,
    save: (key, dataUrl) => ipcRenderer.invoke(IPC.snapshotsSave, key, dataUrl) as Promise<string>,
    url: (key) => ipcRenderer.invoke(IPC.snapshotsUrl, key) as Promise<string | null>
  },
  web: {
    onGuestEscape: (cb) => on<[number]>(IPC.guestEscape, cb),
    onGuestWindowOpen: (cb) => on<[GuestWindowOpen]>(IPC.guestWindowOpen, cb),
    setPageZoom: (guestId, zoom) => ipcRenderer.send(IPC.webSetPageZoom, guestId, zoom)
  },
  terminal: {
    start: (options) => ipcRenderer.invoke(IPC.terminalStart, options) as Promise<TerminalInfo>,
    write: (nodeId, data) => ipcRenderer.send(IPC.terminalWrite, nodeId, data),
    resize: (nodeId, cols, rows) => ipcRenderer.send(IPC.terminalResize, nodeId, cols, rows),
    stop: (nodeId) => ipcRenderer.send(IPC.terminalStop, nodeId),
    defaultShell: () => ipcRenderer.invoke(IPC.terminalShell) as Promise<string>,
    onData: (cb) => on<[{ nodeId: string; data: string }]>(IPC.terminalData, cb),
    onExit: (cb) => on<[{ nodeId: string; exitCode: number; signal?: number }]>(IPC.terminalExit, cb),
    onCwd: (cb) => on<[{ nodeId: string; cwd: string }]>(IPC.terminalCwd, cb),
    onAgentSession: (cb) => on<[{ nodeId: string; sessionId: string }]>(IPC.terminalAgentSession, cb)
  },
  portal: {
    identity: () => ipcRenderer.invoke(IPC.portalIdentity) as Promise<DeviceIdentityView>,
    sign: (data) => ipcRenderer.invoke(IPC.portalSign, data) as Promise<string>,
    verify: (publicKey, fingerprint, data, signature) =>
      ipcRenderer.invoke(IPC.portalVerify, publicKey, fingerprint, data, signature) as Promise<boolean>,
    deliver: (incoming) => ipcRenderer.invoke(IPC.portalDeliver, incoming) as Promise<PortalDelivery>
  },
  snapshot: {
    payload: () => ipcRenderer.invoke(IPC.snapshotPayload) as Promise<SnapshotPayload | null>,
    ready: () => ipcRenderer.send(IPC.snapshotReady)
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList) as Promise<AgentPluginsState>,
    reload: () => ipcRenderer.invoke(IPC.agentsReload) as Promise<AgentPluginsState>,
    openDir: () => ipcRenderer.send(IPC.agentsOpenDir),
    sessions: (plugin, cwd) =>
      ipcRenderer.invoke(IPC.agentsSessions, plugin, cwd) as Promise<AgentSessionInfo[]>
  },
  agent: {
    onRequest: (cb) => on<[AgentRequest]>(IPC.agentRequest, cb),
    respond: (response) => ipcRenderer.send(IPC.agentResponse, response),
    ready: () => ipcRenderer.send(IPC.agentReady)
  },
  menu: {
    onCommand: (cb) => on<[string]>(IPC.menuCommand, cb),
    setEnabled: (state) => ipcRenderer.send(IPC.menuSetEnabled, state)
  }
}

contextBridge.exposeInMainWorld('api', api)
