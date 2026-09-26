import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp } from './helpers'

test('сессия веб-эмбедов переживает перезапуск приложения', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'cnv-persist-ud-'))
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cnv-persist-ws-'))
  await writeFile(
    path.join(workspaceDir, 'web.canvas'),
    JSON.stringify({
      nodes: [
        {
          id: 'web000000000001',
          type: 'link',
          url: 'https://example.com',
          x: 0,
          y: 0,
          width: 640,
          height: 480
        }
      ],
      edges: []
    }),
    'utf8'
  )

  const stamp = `cnv-${Date.now()}`
  const canvasContent = JSON.stringify({
    nodes: [
      { id: 'web000000000001', type: 'link', url: 'https://example.com', x: 0, y: 0, width: 640, height: 480 }
    ],
    edges: []
  })
  const first = await launchApp({ userDataDir, workspaceDir, canvasContent })
  try {
    await first.page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, {
      timeout: 20000
    })
    await first.app.evaluate(async ({ session }, value) => {
      const ses = session.fromPartition('persist:web')
      await ses.cookies.set({
        url: 'https://example.com',
        name: 'cnv_session_probe',
        value,
        expirationDate: Math.floor(Date.now() / 1000) + 3600
      })
      await ses.cookies.flushStore()
    }, stamp)

    // localStorage — то, на чём в реальности держится половина авторизаций.
    const wrote = await first.app.evaluate(async ({ webContents }, value) => {
      const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview')
      if (!guest) return false
      await guest.executeJavaScript(`localStorage.setItem('cnv_probe', ${JSON.stringify(value)})`)
      return true
    }, stamp)
    expect(wrote).toBe(true)
    await first.page.waitForTimeout(800)
  } finally {
    await first.close()
  }

  const second = await launchApp({ userDataDir, workspaceDir, canvasContent })
  try {
    const cookies = await second.app.evaluate(async ({ session }) => {
      const ses = session.fromPartition('persist:web')
      const list = await ses.cookies.get({ name: 'cnv_session_probe' })
      return list.map((c) => c.value)
    })
    expect(cookies).toContain(stamp)

    const appCookies = await second.app.evaluate(async ({ session }) => {
      const list = await session.defaultSession.cookies.get({ name: 'cnv_session_probe' })
      return list.length
    })
    expect(appCookies).toBe(0)

    await second.page.waitForFunction(() => document.querySelectorAll('webview').length > 0, undefined, {
      timeout: 20000
    })
    await second.page.waitForTimeout(2500)
    const storage = await second.app.evaluate(async ({ webContents }) => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const guest = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview')
        if (guest && !guest.isLoading()) {
          return (await guest.executeJavaScript("localStorage.getItem('cnv_probe')")) as string | null
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      return null
    })
    expect(storage).toBe(stamp)
  } finally {
    await second.close()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  }
})

test('гость ходит в сеть под браузерным user-agent, без токена Electron', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cnv-ua-ws-'))
  const h = await launchApp({
    workspaceDir,
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: 'web000000000002',
          type: 'link',
          url: 'https://example.com',
          x: 0,
          y: 0,
          width: 640,
          height: 480
        }
      ],
      edges: []
    })
  })
  try {
    const agents = await h.app.evaluate(({ session }) => ({
      guest: session.fromPartition('persist:web').getUserAgent(),
      app: session.defaultSession.getUserAgent()
    }))
    expect(agents.guest).not.toContain('Electron')
    expect(agents.guest).not.toContain('cnv/')
    expect(agents.guest).toContain('Chrome/')
    expect(agents.app).toContain('Electron')

    const seen = await h.page.evaluate(async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const el = document.querySelector('webview') as unknown as {
          getWebContentsId?(): number
          executeJavaScript?(code: string): Promise<unknown>
        } | null
        if (el?.executeJavaScript) {
          const ua = (await el.executeJavaScript('navigator.userAgent')) as string
          if (ua) return ua
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      return ''
    })
    expect(seen).not.toContain('Electron')
  } finally {
    await h.close()
    await rm(workspaceDir, { recursive: true, force: true })
  }
})
