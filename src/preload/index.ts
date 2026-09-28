import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { FILE_PROTOCOL } from '@shared/app'
import { IPC } from '@shared/ipc'
import type {
  AppApi,
  ClipboardPayload,
  CanvasFileContent,
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
      ipcRenderer.invoke(IPC.attachmentsImportBytes, fileName, bytes) as Promise<ImportedFile>
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
      ipcRenderer.invoke(IPC.filesImageSize, relPath) as Promise<{ width: number; height: number } | null>
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
    onGuestCtrlKey: (cb) => on<[boolean]>(IPC.guestCtrlKey, cb)
  },
  menu: {
    onCommand: (cb) => on<[string]>(IPC.menuCommand, cb),
    setEnabled: (state) => ipcRenderer.send(IPC.menuSetEnabled, state)
  }
}

contextBridge.exposeInMainWorld('api', api)
