import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface Harness {
  app: ElectronApplication
  page: Page
  workspaceRoot: string
  close(): Promise<void>
}

export async function launchApp(options: { workspace?: boolean } = {}): Promise<Harness> {
  const root = process.cwd()
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'cnv-ws-'))
  const userData = await mkdtemp(path.join(tmpdir(), 'cnv-ud-'))
  const args = [path.join(root, 'out/main/index.js'), `--user-data-dir=${userData}`]
  if (options.workspace !== false) args.push(workspaceRoot)

  const app = await electron.launch({ args, cwd: root })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="viewport"]')

  return {
    app,
    page,
    workspaceRoot,
    close: async () => {
      await app.close()
      await rm(workspaceRoot, { recursive: true, force: true })
      await rm(userData, { recursive: true, force: true })
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
