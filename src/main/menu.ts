import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { APP_NAME } from '@shared/app'
import { IPC } from '@shared/ipc'
import { APP_MENU, COMMAND_BY_ID, SEP, type MenuEntry } from '@shared/commands'

let enabledState: Record<string, boolean> = {}

export function setCommandEnabled(win: BrowserWindow | null, state: Record<string, boolean>): void {
  enabledState = state
  buildMenu(win)
}

/** Меню окна собирается из того же дерева, что и ПКМ (`APP_MENU` в shared/commands). */
export function buildMenu(win: BrowserWindow | null): void {
  const send = (id: string): void => win?.webContents.send(IPC.menuCommand, id)

  const items = (entries: readonly MenuEntry[]): MenuItemConstructorOptions[] =>
    entries.flatMap((entry): MenuItemConstructorOptions[] => {
      if (entry === SEP) return [{ type: 'separator' }]
      if (typeof entry !== 'string') return [{ label: entry.label, submenu: items(entry.items) }]
      const cmd = COMMAND_BY_ID.get(entry)
      if (!cmd) return []
      return [
        {
          id: cmd.id,
          label: cmd.label,
          accelerator: cmd.accelerator,
          // Акселератор показываем в меню, но обрабатывать его нативно не даём: на нелатинской
          // раскладке GTK-меню не поймает клавишу. Единственный диспетчер хоткеев — renderer
          // (matchesAccelerator по физкоду), одинаково на любой раскладке и без двойных срабатываний.
          registerAccelerator: false,
          enabled: enabledState[cmd.id] ?? true,
          click: () => send(cmd.id)
        }
      ]
    })

  const template: MenuItemConstructorOptions[] = []
  if (process.platform === 'darwin') {
    template.push({
      label: APP_NAME,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }]
    })
  }
  template.push(...APP_MENU.map((group) => ({ label: group.label, submenu: items(group.items) })))
  const fileMenu = template.find((t) => t.label === 'Файл')
  if (Array.isArray(fileMenu?.submenu)) {
    fileMenu.submenu.push({ type: 'separator' }, { role: 'quit', label: 'Выход' })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.applicationMenu = Menu.getApplicationMenu()
}
