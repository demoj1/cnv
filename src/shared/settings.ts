export type ThemeMode = 'light' | 'dark' | 'system'
export type WindowOpenBehavior = 'new-node' | 'external-browser'
export type MarkdownDropMode = 'embed-content' | 'file-node'

/** Масштаб интерфейса: множитель zoom-фактора окна и гостевых страниц. */
export const UI_SCALES = [1, 1.25, 1.5, 1.75, 2] as const
export type UiScale = (typeof UI_SCALES)[number]

export interface Settings {
  theme: ThemeMode
  uiScale: number
  grid: {
    show: boolean
    snap: boolean
    size: number
  }
  snapping: {
    smartGuides: boolean
    equalSpacing: boolean
    thresholdPx: number
  }
  camera: {
    wheelZooms: boolean
    zoomSpeed: number
  }
  web: {
    /** Сколько веб-нод держать живыми одновременно; 0 — без лимита. */
    liveLimit: number
    /** Ниже этого zoom живых не остаётся; 0 — zoom не выгружает. */
    lodZoomThreshold: number
    /** Через сколько выгружать ушедшую за экран; 0 — не выгружать. */
    offscreenUnloadMs: number
    windowOpen: WindowOpenBehavior
  }
  edges: {
    /** Стороны связи подбираются по расположению нод, а не хранятся намертво. */
    autoSides: boolean
  }
  nodes: {
    textAutoHeight: boolean
    lodZoomThreshold: number
    defaultTextSize: { width: number; height: number }
    defaultWebSize: { width: number; height: number }
    minSize: { width: number; height: number }
  }
  terminal: {
    /** Пусто — брать из `$SHELL`. */
    shell: string
    fontSize: number
  }
  workspace: {
    attachmentsDir: string
    markdownDrop: MarkdownDropMode
  }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  uiScale: 1,
  grid: { show: true, snap: false, size: 20 },
  snapping: { smartGuides: true, equalSpacing: true, thresholdPx: 6 },
  camera: { wheelZooms: false, zoomSpeed: 1 },
  // Нули — «не выгружать»: ни лимита живых, ни порога zoom, ни таймера за экраном.
  web: { liveLimit: 0, lodZoomThreshold: 0, offscreenUnloadMs: 0, windowOpen: 'new-node' },
  edges: { autoSides: true },
  nodes: {
    textAutoHeight: false,
    lodZoomThreshold: 0.4,
    defaultTextSize: { width: 260, height: 120 },
    defaultWebSize: { width: 640, height: 480 },
    minSize: { width: 60, height: 40 }
  },
  terminal: { shell: '', fontSize: 13 },
  workspace: { attachmentsDir: 'attachments', markdownDrop: 'file-node' }
}
