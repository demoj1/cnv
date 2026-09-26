import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launchApp, type Harness } from './helpers'
import type { AppApi } from '@shared/api'

declare global {
  interface Window {
    api: AppApi
  }
}

let h: Harness
let outsideFile: string

test.beforeAll(async () => {
  h = await launchApp()
  await fs.writeFile(path.join(h.workspaceRoot, 'note.md'), '# внутри workspace\n', 'utf8')
  await fs.mkdir(path.join(h.workspaceRoot, 'sub'), { recursive: true })
  await fs.writeFile(path.join(h.workspaceRoot, 'sub', 'deep.txt'), 'глубоко', 'utf8')

  outsideFile = path.join(os.tmpdir(), `cnv-outside-${Date.now()}.txt`)
  await fs.writeFile(outsideFile, 'СЕКРЕТ СНАРУЖИ', 'utf8')
  await fs.symlink(outsideFile, path.join(h.workspaceRoot, 'escape.txt'))
})

test.afterAll(async () => {
  await fs.rm(outsideFile, { force: true })
  await h.close()
})

const fetchProtocol = async (url: string): Promise<{ status: number; body: string; type: string }> =>
  h.page.evaluate(async (u) => {
    const r = await fetch(u)
    return { status: r.status, body: await r.text(), type: r.headers.get('content-type') ?? '' }
  }, url)

test('workspace открывается из CLI-аргумента', async () => {
  const info = await h.page.evaluate(() => window.api.workspace.current())
  expect(info?.root).toBe(h.workspaceRoot)
})

test('файл внутри workspace отдаётся с корректным Content-Type', async () => {
  const res = await fetchProtocol('canvas-file://workspace/note.md')
  expect(res.status).toBe(200)
  expect(res.body).toContain('внутри workspace')
  expect(res.type).toContain('text/markdown')

  const deep = await fetchProtocol('canvas-file://workspace/sub/deep.txt')
  expect(deep.status).toBe(200)
  expect(deep.body).toBe('глубоко')
})

test('выход за корень запрещён', async () => {
  for (const url of [
    'canvas-file://workspace/../../../etc/passwd',
    'canvas-file://workspace/..%2F..%2Fetc%2Fpasswd',
    'canvas-file://workspace/sub/../../etc/hostname'
  ]) {
    const res = await fetchProtocol(url)
    expect(res.status, url).not.toBe(200)
  }
})

test('симлинк наружу не отдаётся', async () => {
  const res = await fetchProtocol('canvas-file://workspace/escape.txt')
  expect(res.status).toBe(403)
  expect(res.body).not.toContain('СЕКРЕТ')
})

test('чужой host отвергается', async () => {
  const res = await fetchProtocol('canvas-file://elsewhere/note.md')
  expect(res.status).toBe(400)
})

test('files.readText тоже не выпускает за корень', async () => {
  const inside = await h.page.evaluate(() => window.api.files.readText('note.md'))
  expect(inside).toContain('внутри workspace')

  const outside = await h.page.evaluate(() => window.api.files.readText('../../../etc/hostname'))
  expect(outside).toBeNull()

  const viaSymlink = await h.page.evaluate(() => window.api.files.readText('escape.txt'))
  expect(viaSymlink).toBeNull()
})

test('окно приложения не уводится навигацией', async () => {
  const before = h.page.url()
  await h.page.evaluate(() => {
    location.href = 'https://example.com'
  })
  await h.page.waitForTimeout(500)
  expect(h.page.url()).toBe(before)
})
