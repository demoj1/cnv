import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CANVAS_CONTEXT_MENU, NODE_CONTEXT_MENU, type MenuEntry } from '../../src/shared/commands'

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
  // Без оконного менеджера Xvfb Electron иногда оставляет окно минимальным (720×480),
  // хотя createMainWindow запросил 1440×920. Координаты тестов относятся к полному окну.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setSize(1440, 920)
  })

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

/**
 * Камера по умолчанию кладёт начало мира в левый-верх вьюпорта, поэтому ноды на нулевых и
 * отрицательных координатах оказываются за экраном — клик по ним у Playwright таймаутит.
 * Зови это в `beforeAll`, если тесту надо кликать/тащить ноды: кнопка «вписать всё» (первая
 * в HUD) приводит весь контент в кадр.
 */
export async function fitAll(page: Page): Promise<void> {
  await page.locator('.hud__icon').nth(0).click()
  await page.waitForTimeout(400)
}

export async function cameraState(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const world = document.querySelector('[data-testid="world"]') as HTMLElement
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world.style.transform)
    if (!m) throw new Error(`не разобрал transform: ${world.style.transform}`)
    return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }
  })
}

/** Путь подменю до команды в ПКМ-меню (по дереву из shared/commands). */
function menuPath(entries: readonly MenuEntry[], id: string): string[] | null {
  for (const e of entries) {
    if (e === id) return []
    if (typeof e !== 'string') {
      const inner = menuPath(e.items, id)
      if (inner) return [e.label, ...inner]
    }
  }
  return null
}

/** Клик по команде открытого ПКМ-меню: подменю на пути раскрываются наведением, как у человека. */
export async function clickMenuCommand(page: Page, id: string): Promise<void> {
  await page.waitForSelector('[data-testid="context-menu"]')
  const path = menuPath(NODE_CONTEXT_MENU, id) ?? menuPath(CANVAS_CONTEXT_MENU, id) ?? []
  let scope = page.getByTestId('context-menu')
  for (const label of path) {
    const sub = scope.locator(`[data-submenu="${label}"]`).first()
    await sub.hover()
    scope = sub
  }
  await scope.locator(`[data-command="${id}"]`).first().click()
}
