import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { FILE_PROTOCOL } from '@shared/app'
import { IPC } from '@shared/ipc'
import type {
  AppApi,
  CanvasFileContent,
  CanvasFileInfo,
  DeepPartial,
  ExternalChange,
  GuestWindowOpen,
  ImportedFile,
  Unsubscribe,
  WorkspaceInfo,
  WriteResult
} from '@shared/api'
import type { Settings } from '@shared/settings'

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
    choose: () => ipcRenderer.invoke(IPC.workspaceChoose) as Promise<WorkspaceInfo | null>,
    open: (root) => ipcRenderer.invoke(IPC.workspaceOpen, root) as Promise<WorkspaceInfo | null>,
    recent: () => ipcRenderer.invoke(IPC.workspaceRecent) as Promise<string[]>,
    list: () => ipcRenderer.invoke(IPC.workspaceList) as Promise<CanvasFileInfo[]>,
    onListChanged: (cb) => on<[CanvasFileInfo[]]>(IPC.workspaceListChanged, cb),
    onOpened: (cb) => on<[WorkspaceInfo | null]>(IPC.workspaceOpened, cb)
  },
  canvas: {
    read: (relPath) => ipcRenderer.invoke(IPC.canvasRead, relPath) as Promise<CanvasFileContent>,
    write: (relPath, text) => ipcRenderer.invoke(IPC.canvasWrite, relPath, text) as Promise<WriteResult>,
    create: (relPath) => ipcRenderer.invoke(IPC.canvasCreate, relPath) as Promise<CanvasFileInfo>,
    rename: (from, to) => ipcRenderer.invoke(IPC.canvasRename, from, to) as Promise<CanvasFileInfo>,
    remove: (relPath) => ipcRenderer.invoke(IPC.canvasRemove, relPath) as Promise<void>,
    onExternalChange: (cb) => on<[ExternalChange]>(IPC.canvasExternalChange, cb),
    onOpenRequest: (cb) => on<[string]>(IPC.canvasOpenRequest, cb)
  },
  attachments: {
    importPath: (sourcePath) =>
      ipcRenderer.invoke(IPC.attachmentsImportPath, sourcePath) as Promise<ImportedFile>,
    importBytes: (fileName, bytes) =>
      ipcRenderer.invoke(IPC.attachmentsImportBytes, fileName, bytes) as Promise<ImportedFile>
  },
  files: {
    url: (relPath) => `${FILE_PROTOCOL}://workspace/${relPath.split('/').map(encodeURIComponent).join('/')}`,
    stat: (relPath) =>
      ipcRenderer.invoke(IPC.filesStat, relPath) as Promise<{ size: number; mtimeMs: number } | null>,
    readText: (relPath) => ipcRenderer.invoke(IPC.filesReadText, relPath) as Promise<string | null>,
    openInSystem: (relPath) => ipcRenderer.invoke(IPC.filesOpenInSystem, relPath) as Promise<void>,
    choose: (filters) => ipcRenderer.invoke(IPC.filesChoose, filters) as Promise<string[]>,
    preview: (relPath, maxSide) =>
      ipcRenderer.invoke(IPC.filesPreview, relPath, maxSide) as Promise<string | null>
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shellOpenExternal, url) as Promise<void>
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
    patch: (patch: DeepPartial<Settings>) =>
      ipcRenderer.invoke(IPC.settingsPatch, patch) as Promise<Settings>,
    onChanged: (cb) => on<[Settings]>(IPC.settingsChanged, cb)
  },
  snapshots: {
    save: (key, dataUrl) => ipcRenderer.invoke(IPC.snapshotsSave, key, dataUrl) as Promise<string>,
    url: (key) => ipcRenderer.invoke(IPC.snapshotsUrl, key) as Promise<string | null>
  },
  web: {
    onGuestEscape: (cb) => on<[number]>(IPC.guestEscape, cb),
    onGuestWindowOpen: (cb) => on<[GuestWindowOpen]>(IPC.guestWindowOpen, cb)
  },
  menu: {
    onCommand: (cb) => on<[string]>(IPC.menuCommand, cb),
    setEnabled: (state) => ipcRenderer.send(IPC.menuSetEnabled, state)
  }
}

contextBridge.exposeInMainWorld('api', api)
