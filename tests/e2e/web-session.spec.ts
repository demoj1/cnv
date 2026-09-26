import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp } from './helpers'

test('логин в веб-эмбеде переживает перезапуск приложения', async () => {
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
  const first = await launchApp({ userDataDir, workspaceDir })
  try {
    await first.page.click('[data-canvas="web.canvas"] .sidebar__open')
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
    await first.page.waitForTimeout(500)
  } finally {
    await first.close()
  }

  const second = await launchApp({ userDataDir, workspaceDir })
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
  } finally {
    await second.close()
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  }
})
