import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Брошенный на холст .html открывается живой страницей в webview (веб-нода с адресом
 * canvas-file://), а не файловой нодой. Тут проверяем самое рискованное: гость реально
 * грузит canvas-file из СВОЕЙ partition-сессии — без регистрации протокола на ней
 * страница осталась бы пустой.
 */

let h: Harness

test.beforeAll(async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'cnv-html-'))
  await mkdir(path.join(ws, 'attachments'), { recursive: true })
  await writeFile(
    path.join(ws, 'attachments', 'page.html'),
    '<!doctype html><meta charset="utf-8"><title>ЛОКАЛ</title><h1 id="m">LOCAL-HTML-OK</h1>'
  )
  await writeFile(
    path.join(ws, 'scratchpad.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: 'web000000000001',
          type: 'link',
          url: 'canvas-file://workspace/attachments/page.html',
          x: 0,
          y: 0,
          width: 640,
          height: 480
        }
      ],
      edges: []
    })
  )
  h = await launchApp({ workspaceDir: ws })
  await h.page.waitForTimeout(500)
})

test.afterAll(async () => {
  await h.close()
})

test('локальный html грузится в госте из canvas-file', async () => {
  await expect.poll(() => h.page.locator('webview').count(), { timeout: 20000 }).toBe(1)

  const wcId = await h.page.evaluate(() => {
    const el = document.querySelector('webview')
    return el ? (el as unknown as { getWebContentsId(): number }).getWebContentsId() : -1
  })
  expect(wcId).toBeGreaterThan(0)

  await expect
    .poll(
      () =>
        h.app.evaluate(({ webContents }, id) => {
          const g = webContents.fromId(id)
          return g ? g.executeJavaScript('document.getElementById("m")?.textContent || ""') : ''
        }, wcId),
      { timeout: 20000 }
    )
    .toContain('LOCAL-HTML-OK')
})

test('за пределы воркспейса гость через canvas-file не выйдет', async () => {
  // Песочница по realpath: ..-обход и абсолютный путь наружу должны получить отказ.
  const wcId = await h.page.evaluate(() => {
    const el = document.querySelector('webview')
    return (el as unknown as { getWebContentsId(): number }).getWebContentsId()
  })
  const status = await h.app.evaluate(({ webContents }, id) => {
    const g = webContents.fromId(id)
    return g
      ? g.executeJavaScript(
          "fetch('canvas-file://workspace/../../../etc/passwd').then(r => r.status).catch(() => 'err')"
        )
      : null
  }, wcId)
  expect([403, 400, 404, 'err']).toContain(status)
})
