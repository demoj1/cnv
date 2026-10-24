import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { launchApp, type Harness } from './helpers'

/** Кнопки −/+ в шапке веб-ноды: масштаб самой страницы, поверх UI-скейла, запоминается в файле. */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: 'web000000000001',
          type: 'link',
          url: 'https://example.com',
          x: 200,
          y: 100,
          width: 640,
          height: 480
        }
      ],
      edges: []
    })
  })
})
test.afterAll(async () => {
  await h.close()
})

const guestZoom = (): Promise<number[]> =>
  h.app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((wc) => wc.getType() === 'webview')
      .map((wc) => wc.getZoomFactor())
  )

test('−/+ меняют масштаб страницы, процент сбрасывает на 100%', async () => {
  await h.page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, {
    timeout: 20000
  })
  await h.page.getByTestId('web-shield').click()
  const zoom = h.page.getByTestId('web-zoom')
  await expect(zoom).toHaveText('100%')
  await expect.poll(guestZoom, { timeout: 20000 }).toEqual([1])

  await h.page.getByTitle('Крупнее').click()
  await h.page.getByTitle('Крупнее').click()
  await expect(zoom).toHaveText('125%')
  await expect.poll(guestZoom).toEqual([1.25])

  // Масштаб запомнен в .canvas, в виде ноды.
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  await expect
    .poll(
      async () =>
        JSON.parse(await fs.readFile(h.canvasFile, 'utf8'))['x-cnv']?.nodes?.web000000000001?.webZoom
    )
    .toBe(1.25)

  await h.page.getByTitle('Мельче').click()
  await expect(zoom).toHaveText('110%')
  await zoom.click()
  await expect(zoom).toHaveText('100%')
  await expect.poll(guestZoom).toEqual([1])
})
