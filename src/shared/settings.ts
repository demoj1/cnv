export type ThemeMode = 'light' | 'dark' | 'system'
export type WindowOpenBehavior = 'new-node' | 'external-browser'
export type MarkdownDropMode = 'embed-content' | 'file-node'

export interface Settings {
  theme: ThemeMode
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
    liveLimit: number
    lodZoomThreshold: number
    offscreenUnloadMs: number
    windowOpen: WindowOpenBehavior
  }
  nodes: {
    textAutoHeight: boolean
    lodZoomThreshold: number
    defaultTextSize: { width: number; height: number }
    defaultWebSize: { width: number; height: number }
    minSize: { width: number; height: number }
  }
  workspace: {
    attachmentsDir: string
    markdownDrop: MarkdownDropMode
  }
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  grid: { show: true, snap: false, size: 20 },
  snapping: { smartGuides: true, equalSpacing: true, thresholdPx: 6 },
  camera: { wheelZooms: false, zoomSpeed: 1 },
  web: { liveLimit: 6, lodZoomThreshold: 0.35, offscreenUnloadMs: 20000, windowOpen: 'new-node' },
  nodes: {
    textAutoHeight: false,
    lodZoomThreshold: 0.4,
    defaultTextSize: { width: 260, height: 120 },
    defaultWebSize: { width: 640, height: 480 },
    minSize: { width: 60, height: 40 }
  },
  workspace: { attachmentsDir: 'attachments', markdownDrop: 'file-node' }
}
