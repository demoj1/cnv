import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

/**
 * Служебные скрытые окна — фоновые вкладки агентов, снимки нод. Это не окно холста: их
 * навигация не сбрасывает мост MCP, их закрытие не трогает вкладки. `browser-window-created`
 * прилетает прямо из конструктора — поэтому помечаем и на время создания.
 */
const helpers = new WeakSet<BrowserWindow>()
let creating = 0

export function createHelperWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  creating++
  try {
    const win = new BrowserWindow(options)
    helpers.add(win)
    return win
  } finally {
    creating--
  }
}

export const isHelperWindow = (win: BrowserWindow): boolean => creating > 0 || helpers.has(win)
