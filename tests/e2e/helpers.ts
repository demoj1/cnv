import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface Harness {
  app: ElectronApplication
  page: Page
  workspaceRoot: string
  /** Единственный канвас приложения. */
  canvasFile: string
  close(): Promise<void>
}

export const CANVAS_NAME = 'scratchpad.canvas'

export async function launchApp(
  options: {
    userDataDir?: string
    workspaceDir?: string
    canvasName?: string
    /** Содержимое единственного канваса на момент старта приложения. */
    canvasContent?: string
  } = {}
): Promise<Harness> {
  const root = process.cwd()
  const workspaceRoot = options.workspaceDir ?? (await mkdtemp(path.join(tmpdir(), 'cnv-ws-')))
  const userData = options.userDataDir ?? (await mkdtemp(path.join(tmpdir(), 'cnv-ud-')))
  const canvasFile = path.join(workspaceRoot, options.canvasName ?? CANVAS_NAME)
  if (options.canvasContent !== undefined) await writeFile(canvasFile, options.canvasContent, 'utf8')
  const args = [path.join(root, 'out/main/index.js'), `--user-data-dir=${userData}`, canvasFile]

  const app = await electron.launch({ args, cwd: root })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="viewport"]')
  await page.waitForFunction(() => Boolean((window as { __cnvFlush?: unknown }).__cnvFlush), undefined, {
    timeout: 20000
  })

  return {
    app,
    page,
    workspaceRoot,
    canvasFile,
    close: async () => {
      await app.close()
      if (!options.workspaceDir) await rm(workspaceRoot, { recursive: true, force: true })
      if (!options.userDataDir) await rm(userData, { recursive: true, force: true })
    }
  }
}

export async function cameraState(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const world = document.querySelector('[data-testid="world"]') as HTMLElement
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform)
    if (!m) throw new Error(`не разобрал transform: ${world.style.transform}`)
    return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }
  })
}
