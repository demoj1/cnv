import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppApi } from '@shared/api'

declare global {
  interface Window {
    api: AppApi
    __cnvFlush?: () => Promise<void>
  }
}

/**
 * Главный сценарий владельца: запуск без аргументов, как из ярлыка. Канваса ещё нет —
 * приложение обязано создать его само и в следующий раз открыть именно его.
 */
test('без аргументов приложение само заводит свой канвас и помнит его', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'cnv-default-ud-'))
  const home = await mkdtemp(path.join(tmpdir(), 'cnv-default-home-'))

  const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await electron.launch({
      args: [path.join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${userData}`],
      cwd: process.cwd(),
      env: { ...process.env, HOME: home }
    })
    const page = await app.firstWindow()
    await page.waitForSelector('[data-testid="viewport"]')
    await page.waitForFunction(() => Boolean(window.__cnvFlush), undefined, { timeout: 20000 })
    await page.waitForTimeout(1500)
    return { app, page }
  }

  try {
    const first = await launch()
    const file = await first.page.evaluate(() => window.api.canvas.currentFile())
    expect(file).not.toBeNull()
    expect(file?.startsWith(home)).toBe(true)
    expect(file?.endsWith('scratchpad.canvas')).toBe(true)
    expect((await stat(file as string)).size).toBeGreaterThan(0)

    await first.page.locator('[data-testid="viewport"]').dblclick({ position: { x: 400, y: 300 } })
    await first.page.keyboard.type('первая заметка')
    await first.page.keyboard.press('Escape')
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await first.app.waitForEvent('close').catch(() => undefined)

    expect(await readFile(file as string, 'utf8')).toContain('первая заметка')
    const settings = JSON.parse(await readFile(path.join(userData, 'settings.json'), 'utf8'))
    expect(settings.canvasPath).toBe(file)

    const second = await launch()
    expect(await second.page.evaluate(() => window.api.canvas.currentFile())).toBe(file)
    await expect(second.page.locator('[data-node-id]')).toHaveCount(1)
    await second.app.close()
  } finally {
    await rm(userData, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})
