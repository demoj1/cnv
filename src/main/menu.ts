import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '@shared/app'
import { IPC } from '@shared/ipc'
import { COMMANDS, MENU_SECTIONS, SECTION_LABELS, type CommandSection } from '@shared/commands'

let enabledState: Record<string, boolean> = {}

export function setCommandEnabled(win: BrowserWindow | null, state: Record<string, boolean>): void {
  enabledState = state
  buildMenu(win)
}

export function buildMenu(win: BrowserWindow | null): void {
  const send = (id: string): void => win?.webContents.send(IPC.menuCommand, id)

  const sectionMenu = (section: CommandSection): MenuItemConstructorOptions => {
    const items: MenuItemConstructorOptions[] = []
    for (const cmd of COMMANDS.filter((c) => c.section === section && !c.hidden)) {
      if (cmd.separatorBefore && items.length > 0) items.push({ type: 'separator' })
      items.push({
        id: cmd.id,
        label: cmd.label,
        accelerator: cmd.accelerator,
        enabled: enabledState[cmd.id] ?? true,
        click: () => send(cmd.id)
      })
    }
    return { label: SECTION_LABELS[section], submenu: items }
  }

  const template: MenuItemConstructorOptions[] = []
  if (process.platform === 'darwin') {
    template.push({
      label: APP_NAME,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }]
    })
  }
  template.push(...MENU_SECTIONS.map(sectionMenu))
  const fileMenu = template.find((t) => t.label === SECTION_LABELS.file)
  if (Array.isArray(fileMenu?.submenu)) {
    fileMenu.submenu.push({ type: 'separator' }, { role: 'quit', label: 'Выход' })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.applicationMenu = Menu.getApplicationMenu()
}
