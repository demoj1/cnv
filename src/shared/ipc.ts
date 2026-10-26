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
  attachmentsRefresh: 'attachments:refresh',

  filesStat: 'files:stat',
  filesReadText: 'files:read-text',
  filesOpenInSystem: 'files:open-in-system',
  filesChoose: 'files:choose',
  filesPreview: 'files:preview',
  filesImageSize: 'files:image-size',
  filesChanged: 'files:changed',
  filesTrack: 'files:track',
  filesReadDoc: 'files:read-doc',
  filesWriteDoc: 'files:write-doc',

  shellOpenExternal: 'shell:open-external',

  clipboardWriteCanvas: 'clipboard:write-canvas',
  clipboardWriteText: 'clipboard:write-text',
  clipboardRead: 'clipboard:read',

  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsChanged: 'settings:changed',

  snapshotsCapture: 'snapshots:capture',
  webSetPageZoom: 'web:set-page-zoom',
  terminalAgentSession: 'terminal:agent-session',
  agentsList: 'agents:list',
  agentsReload: 'agents:reload',
  agentsOpenDir: 'agents:open-dir',
  agentsSessions: 'agents:sessions',
  agentsNotify: 'agents:notify',
  agentsTimerTick: 'agents:timer-tick',
  snapshotPayload: 'snapshot:payload',
  portalIdentity: 'portal:identity',
  portalSign: 'portal:sign',
  portalVerify: 'portal:verify',
  portalDeliver: 'portal:deliver',
  snapshotReady: 'snapshot:ready',
  snapshotsSave: 'snapshots:save',
  snapshotsUrl: 'snapshots:url',

  guestEscape: 'web:guest-escape',
  guestWindowOpen: 'web:guest-window-open',

  terminalStart: 'terminal:start',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalStop: 'terminal:stop',
  terminalPause: 'terminal:pause',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalCwd: 'terminal:cwd',
  terminalShell: 'terminal:shell',

  agentRequest: 'agent:request',
  agentResponse: 'agent:response',
  agentReady: 'agent:ready',

  menuCommand: 'menu:command',
  menuSetEnabled: 'menu:set-enabled'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
