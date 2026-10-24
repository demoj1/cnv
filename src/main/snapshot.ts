import { ipcMain, webContents } from 'electron'
import path from 'node:path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import type { SnapshotPayload, SnapshotRect } from '@shared/snapshot'
import { createHelperWindow } from './helper-windows'

/**
 * Снимок нод без сдвига камеры человеку: скрытое окно грузит тот же холст в режиме
 * «#snapshot», рисует только переданные ноды под нужный прямоугольник и говорит «готово» —
 * тогда его и снимаем. Терминалы и веб-страницы живые только в окне холста — их экраны
 * и кадры приходят готовыми.
 */

/** Больше этого по стороне — уменьшаем масштаб: окно и PNG не резиновые. */
const MAX_SIDE = 4096
const READY_TIMEOUT_MS = 20_000

interface Pending {
  payload: SnapshotPayload
  ready(): void
}

const pending = new Map<number, Pending>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  ipcMain.handle(IPC.snapshotPayload, (e) => pending.get(e.sender.id)?.payload ?? null)
  ipcMain.on(IPC.snapshotReady, (e) => pending.get(e.sender.id)?.ready())
}

export interface SnapshotSource {
  nodes: unknown[]
  edges: unknown[]
  rect: SnapshotRect
  terminals: Record<string, string>
  webGuests: Record<string, number>
}

/** PNG (base64) нод из `source` в масштабе `scale` (1 — как на холсте при 100 %). */
export async function renderSnapshot(source: SnapshotSource, scale = 1): Promise<string> {
  wire()
  const { rect } = source
  const fit = Math.min(scale, MAX_SIDE / Math.max(rect.width, 1), MAX_SIDE / Math.max(rect.height, 1))
  const width = Math.max(16, Math.round(rect.width * fit))
  const height = Math.max(16, Math.round(rect.height * fit))

  // Живые веб-страницы — кадрами из их собственного браузера.
  const web: Record<string, string> = {}
  for (const [nodeId, guestId] of Object.entries(source.webGuests)) {
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) continue
    const image = await guest.capturePage().catch(() => null)
    if (image && !image.isEmpty()) web[nodeId] = image.toDataURL()
  }

  const win = createHelperWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('снимок не дорисовался за 20 с')), READY_TIMEOUT_MS)
      pending.set(win.webContents.id, {
        payload: {
          nodes: source.nodes,
          edges: source.edges,
          rect,
          terminals: source.terminals,
          web
        },
        ready: () => {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#snapshot`)
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'snapshot' })
    }
    await ready
    const image = await win.webContents.capturePage()
    // Кадр приходит в пикселях экрана (на Wayland у скрытого окна бывает дробный масштаб) —
    // приводим к запрошенному размеру, чтобы scale значил ровно то, что обещано.
    const size = image.getSize()
    const exact =
      size.width === width && size.height === height
        ? image
        : image.resize({ width, height, quality: 'best' })
    return exact.toPNG().toString('base64')
  } finally {
    pending.delete(win.webContents.id)
    win.destroy()
  }
}
