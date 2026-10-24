import type { BrowserWindow } from 'electron'
import { createHelperWindow } from '../helper-windows'
import { WEB_PARTITION } from '@shared/app'

/**
 * Фоновые вкладки для агентов: живой браузер в общей сессии cnv (с логинами человека), но
 * без ноды на холсте — чтобы параллелить обход сайтов, не засоряя холст. Окна скрыты и не
 * засыпают в фоне; навигация — только http(s), новые окна не открываются.
 */
export interface TabInfo {
  id: string
  webContentsId: number
  url: string
  title: string
}

const MAX_TABS = 12
const LOAD_TIMEOUT_MS = 30_000

export class TabManager {
  private tabs = new Map<string, BrowserWindow>()
  private next = 1

  list(): TabInfo[] {
    return [...this.tabs].map(([id, win]) => this.info(id, win))
  }

  get(id: string): TabInfo | undefined {
    const win = this.tabs.get(id)
    return win && !win.isDestroyed() ? this.info(id, win) : undefined
  }

  async open(url: string): Promise<TabInfo> {
    if (!/^https?:\/\//i.test(url)) throw new Error('нужен http(s)-адрес')
    if (this.tabs.size >= MAX_TABS)
      throw new Error(`не больше ${MAX_TABS} вкладок — закрой лишние (tab_close)`)
    const win = createHelperWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: WEB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    const id = `tab-${this.next++}`
    this.tabs.set(id, win)
    win.on('closed', () => this.tabs.delete(id))
    const wc = win.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event, target) => {
      if (!/^https?:\/\//i.test(target)) event.preventDefault()
    })
    await this.load(win, url)
    return this.info(id, win)
  }

  async navigate(id: string, url: string): Promise<TabInfo> {
    const win = this.tabs.get(id)
    if (!win || win.isDestroyed()) throw new Error(`нет вкладки ${id}`)
    if (!/^https?:\/\//i.test(url)) throw new Error('нужен http(s)-адрес')
    await this.load(win, url)
    return this.info(id, win)
  }

  close(id: string): boolean {
    const win = this.tabs.get(id)
    if (!win) return false
    this.tabs.delete(id)
    if (!win.isDestroyed()) win.destroy()
    return true
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id)
  }

  private info(id: string, win: BrowserWindow): TabInfo {
    const wc = win.webContents
    return { id, webContentsId: wc.id, url: wc.getURL(), title: wc.getTitle() }
  }

  private load(win: BrowserWindow, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), LOAD_TIMEOUT_MS)
      win.webContents
        .loadURL(url)
        .then(() => {
          clearTimeout(timer)
          resolve()
        })
        .catch((error: unknown) => {
          clearTimeout(timer)
          // Редирект или отменённая подзагрузка — страница всё равно есть; настоящий отказ —
          // когда адреса так и нет.
          if (win.webContents.getURL()) resolve()
          else reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }
}
