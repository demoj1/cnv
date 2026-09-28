export const IPC = {
  workspaceCurrent: 'workspace:current',
  workspaceOpened: 'workspace:opened',

  canvasCurrent: 'canvas:current',
  canvasChooseFile: 'canvas:choose-file',

  canvasRead: 'canvas:read',
  canvasWrite: 'canvas:write',
  canvasExternalChange: 'canvas:external-change',
  canvasOpenRequest: 'canvas:open-request',

  attachmentsImportPath: 'attachments:import-path',
  attachmentsImportBytes: 'attachments:import-bytes',

  filesStat: 'files:stat',
  filesReadText: 'files:read-text',
  filesOpenInSystem: 'files:open-in-system',
  filesChoose: 'files:choose',
  filesPreview: 'files:preview',
  filesImageSize: 'files:image-size',

  shellOpenExternal: 'shell:open-external',

  clipboardWriteCanvas: 'clipboard:write-canvas',
  clipboardWriteText: 'clipboard:write-text',
  clipboardRead: 'clipboard:read',

  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsChanged: 'settings:changed',

  snapshotsCapture: 'snapshots:capture',
  snapshotsSave: 'snapshots:save',
  snapshotsUrl: 'snapshots:url',

  guestEscape: 'web:guest-escape',
  guestWindowOpen: 'web:guest-window-open',

  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalStop: 'terminal:stop',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalCwd: 'terminal:cwd',
  terminalShell: 'terminal:shell',

  menuCommand: 'menu:command',
  menuSetEnabled: 'menu:set-enabled'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
