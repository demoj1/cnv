export const IPC = {
  workspaceCurrent: 'workspace:current',
  workspaceChoose: 'workspace:choose',
  workspaceOpen: 'workspace:open',
  workspaceRecent: 'workspace:recent',
  workspaceList: 'workspace:list',
  workspaceListChanged: 'workspace:list-changed',
  workspaceOpened: 'workspace:opened',

  canvasRead: 'canvas:read',
  canvasWrite: 'canvas:write',
  canvasCreate: 'canvas:create',
  canvasRename: 'canvas:rename',
  canvasRemove: 'canvas:remove',
  canvasExternalChange: 'canvas:external-change',
  canvasOpenRequest: 'canvas:open-request',

  attachmentsImportPath: 'attachments:import-path',
  attachmentsImportBytes: 'attachments:import-bytes',

  filesStat: 'files:stat',
  filesReadText: 'files:read-text',
  filesOpenInSystem: 'files:open-in-system',
  filesChoose: 'files:choose',
  filesPreview: 'files:preview',

  shellOpenExternal: 'shell:open-external',

  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  settingsChanged: 'settings:changed',

  snapshotsCapture: 'snapshots:capture',
  snapshotsSave: 'snapshots:save',
  snapshotsUrl: 'snapshots:url',

  guestEscape: 'web:guest-escape',
  guestWindowOpen: 'web:guest-window-open',

  menuCommand: 'menu:command',
  menuSetEnabled: 'menu:set-enabled'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
