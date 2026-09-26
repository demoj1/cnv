import type { Settings } from './settings'

export interface WorkspaceInfo {
  root: string
  name: string
}

export interface CanvasFileInfo {
  relPath: string
  name: string
  mtimeMs: number
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
    choose(): Promise<WorkspaceInfo | null>
    open(root: string): Promise<WorkspaceInfo | null>
    recent(): Promise<string[]>
    list(): Promise<CanvasFileInfo[]>
    onListChanged(cb: (files: CanvasFileInfo[]) => void): Unsubscribe
    onOpened(cb: (info: WorkspaceInfo | null) => void): Unsubscribe
  }
  canvas: {
    read(relPath: string): Promise<CanvasFileContent>
    write(relPath: string, text: string): Promise<WriteResult>
    create(relPath: string): Promise<CanvasFileInfo>
    rename(fromRel: string, toRel: string): Promise<CanvasFileInfo>
    remove(relPath: string): Promise<void>
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
    preview(relPath: string, maxSide: number): Promise<string | null>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    patch(patch: DeepPartial<Settings>): Promise<Settings>
    onChanged(cb: (settings: Settings) => void): Unsubscribe
  }
  snapshots: {
    save(key: string, dataUrl: string): Promise<string>
    url(key: string): Promise<string | null>
  }
  web: {
    onGuestEscape(cb: (guestId: number) => void): Unsubscribe
    onGuestWindowOpen(cb: (e: GuestWindowOpen) => void): Unsubscribe
  }
  menu: {
    onCommand(cb: (commandId: string) => void): Unsubscribe
    setEnabled(state: Record<string, boolean>): void
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
