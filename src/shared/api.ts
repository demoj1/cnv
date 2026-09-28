import type { Settings } from './settings'

export interface WorkspaceInfo {
  root: string
  name: string
}

export interface CanvasFileContent {
  relPath: string
  text: string
  mtimeMs: number
}

export interface WriteResult {
  mtimeMs: number
}

export interface ExternalChange {
  relPath: string
  kind: 'change' | 'unlink'
  mtimeMs: number
}

export interface ImportedFile {
  relPath: string
  copied: boolean
}

export interface ClipboardPayload {
  canvas: string | null
  text: string | null
  image: { name: string; bytes: ArrayBuffer } | null
}

export interface GuestWindowOpen {
  guestId: number
  url: string
}

export type Unsubscribe = () => void

export interface AppApi {
  platform: {
    os: string
    isLinux: boolean
    isMac: boolean
    isWindows: boolean
  }
  workspace: {
    current(): Promise<WorkspaceInfo | null>
    onOpened(cb: (info: WorkspaceInfo | null) => void): Unsubscribe
  }
  canvas: {
    /** Абсолютный путь к единственному файлу приложения. */
    currentFile(): Promise<string | null>
    /** Диалог «хранить канвас здесь»; после выбора файл переоткрывается. */
    chooseFile(): Promise<string | null>
    read(relPath: string): Promise<CanvasFileContent>
    write(relPath: string, text: string): Promise<WriteResult>
    onExternalChange(cb: (change: ExternalChange) => void): Unsubscribe
    onOpenRequest(cb: (relPath: string) => void): Unsubscribe
  }
  attachments: {
    importPath(sourcePath: string): Promise<ImportedFile>
    importBytes(fileName: string, bytes: ArrayBuffer): Promise<ImportedFile>
  }
  files: {
    url(relPath: string): string
    stat(relPath: string): Promise<{ size: number; mtimeMs: number } | null>
    readText(relPath: string): Promise<string | null>
    openInSystem(relPath: string): Promise<void>
    choose(filters?: { name: string; extensions: string[] }[]): Promise<string[]>
    /** Абсолютный путь файла, брошенного на окно: File.path в sandbox недоступен. */
    pathForDrop(file: File): string
    preview(relPath: string, maxSide: number): Promise<string | null>
    imageSize(relPath: string): Promise<{ width: number; height: number } | null>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  clipboard: {
    writeCanvas(fragment: string): Promise<void>
    writeText(text: string): Promise<void>
    read(): Promise<ClipboardPayload>
  }
  settings: {
    get(): Promise<Settings>
    patch(patch: DeepPartial<Settings>): Promise<Settings>
    onChanged(cb: (settings: Settings) => void): Unsubscribe
  }
  snapshots: {
    capture(webContentsId: number): Promise<string | null>
    save(key: string, dataUrl: string): Promise<string>
    url(key: string): Promise<string | null>
  }
  web: {
    onGuestEscape(cb: (guestId: number) => void): Unsubscribe
    onGuestWindowOpen(cb: (e: GuestWindowOpen) => void): Unsubscribe
  }
  terminal: {
    start(options: TerminalStart): Promise<TerminalInfo>
    write(nodeId: string, data: string): void
    resize(nodeId: string, cols: number, rows: number): void
    stop(nodeId: string): void
    defaultShell(): Promise<string>
    onData(cb: (e: { nodeId: string; data: string }) => void): Unsubscribe
    onExit(cb: (e: { nodeId: string; exitCode: number; signal?: number }) => void): Unsubscribe
    /** Процесс сделал `cd` — папку надо запомнить в документе. */
    onCwd(cb: (e: { nodeId: string; cwd: string }) => void): Unsubscribe
  }
  menu: {
    onCommand(cb: (commandId: string) => void): Unsubscribe
    setEnabled(state: Record<string, boolean>): void
  }
}

export interface TerminalStart {
  nodeId: string
  shell?: string
  cwd?: string
  cols: number
  rows: number
}

export interface TerminalInfo {
  pid: number
  shell: string
  cwd: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
