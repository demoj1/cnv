import type { AgentRequest, AgentResponse } from './agent'
import type { AgentPluginsState, AgentSessionInfo } from './agent-plugin'
import type { Settings } from './settings'
import type { SnapshotPayload } from './snapshot'
import type { DeviceIdentityView, PortalDelivery, PortalIncoming } from './portal'

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
  /** Скопирован снаружи workspace — откуда: копия будет следовать за оригиналом. */
  source?: string
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

/** Агентам — что поменялось в их связях и цветах; `by` — кто правил (акторы журнала). */
export interface AgentNotices {
  notices: { nodeId: string; text: string }[]
  by: string[]
}

/** Файл-нода и оригинал, за которым следует её копия (если есть). */
export interface LinkedFile {
  relPath: string
  source?: string
}

/** Текст файла ноды — из оригинала, если копия за ним следует. */
export interface TextFileContent {
  text: string
  mtimeMs: number
  /** Где реально лежит файл — для подсказки человеку. */
  path: string
  tooLarge?: boolean
}

export type TextFileWrite =
  { ok: true; mtimeMs: number } | { ok: false; conflict?: { text: string; mtimeMs: number }; error?: string }

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
    /** Оригинал новее копии — перекопировать. `missing` — оригинала больше нет. */
    refresh(relPath: string, source: string): Promise<{ updated: boolean; missing: boolean }>
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
    /** Файл в workspace поменялся на диске (не .canvas). */
    onChanged(cb: (relPath: string) => void): Unsubscribe
    /** Какие файлы на холсте следуют за оригиналами — main слушает их через inotify. */
    track(files: LinkedFile[]): void
    readDoc(relPath: string): Promise<TextFileContent | null>
    writeDoc(
      relPath: string,
      text: string,
      baseMtimeMs: number | null,
      force?: boolean
    ): Promise<TextFileWrite>
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
    /** Масштаб самой страницы поверх UI-скейла: 1 — как есть. */
    setPageZoom(guestId: number, zoom: number): void
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
    /** Агент начал сессию — её id надо запомнить в документе, чтобы потом продолжить. */
    onAgentSession(cb: (e: { nodeId: string; sessionId: string }) => void): Unsubscribe
  }
  portal: {
    identity(): Promise<DeviceIdentityView>
    sign(data: string): Promise<string>
    verify(publicKey: string, fingerprint: string, data: string, signature: string): Promise<boolean>
    /** Письмо с той стороны портала — доставить агенту здесь. */
    deliver(incoming: PortalIncoming): Promise<PortalDelivery>
  }
  /** Только для скрытого окна снимка нод. */
  snapshot: {
    payload(): Promise<SnapshotPayload | null>
    ready(): void
  }
  agents: {
    list(): Promise<AgentPluginsState>
    /** Перечитать папку своих плагинов. */
    reload(): Promise<AgentPluginsState>
    openDir(): void
    /** Сессии агента `plugin` в папке `cwd`, свежие первыми. */
    sessions(plugin: string, cwd: string | undefined): Promise<AgentSessionInfo[]>
    /** Сказать агентам, что поменялось в их связях и цветах. */
    notify(batch: AgentNotices): void
  }
  agent: {
    /** Запросы MCP-агентов к холсту; ответ — через `respond`. */
    onRequest(cb: (request: AgentRequest) => void): Unsubscribe
    respond(response: AgentResponse): void
    /** Холст подписан и готов отвечать. */
    ready(): void
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
  /** Имя терминала — уходит агенту внутри в `CNV_TERMINAL_NAME`. */
  name?: string
  /** Роль — в `CNV_ROLE` и в системный промпт агента. */
  role?: string
  /**
   * Есть — в шелле сразу запускается агент: продолжает сессию `sessionId` или, если её
   * нет (пустая строка — ещё не было), начинает новую. `plugin` — id плагина, нет — Claude.
   */
  agent?: { plugin?: string; sessionId: string; prompt?: string; model?: string }
}

export interface TerminalInfo {
  pid: number
  shell: string
  cwd: string
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}
