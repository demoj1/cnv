import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LinkedFiles } from '../../src/main/linked-files'
import { Workspace } from '../../src/main/workspace'
import { fileView, withFileView } from '@core/ops'
import type { DocNode } from '@core/document'

let dir: string
let root: string
let workspace: Workspace
let linked: LinkedFiles

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-linked-'))
  root = path.join(dir, 'ws')
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  workspace = new Workspace()
  await workspace.open(root)
  linked = new LinkedFiles(workspace)
})

afterEach(async () => {
  await linked.close()
  await workspace.close()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('текстовые файлы нод', () => {
  it('читает и пишет файл workspace', async () => {
    await fs.writeFile(path.join(root, 'note.md'), '# было')
    const doc = await linked.read('note.md')
    expect(doc?.text).toBe('# было')
    const r = await linked.write('note.md', '# стало', doc?.mtimeMs ?? null)
    expect(r.ok).toBe(true)
    expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe('# стало')
  })

  it('файл поправили снаружи — конфликт, а не затирание; force — перезаписать', async () => {
    const file = path.join(root, 'note.md')
    await fs.writeFile(file, 'один')
    const doc = await linked.read('note.md')
    await fs.writeFile(file, 'снаружи')
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000))
    const r = await linked.write('note.md', 'мой', doc?.mtimeMs ?? null)
    expect(r).toMatchObject({ ok: false, conflict: { text: 'снаружи' } })
    expect(await fs.readFile(file, 'utf8')).toBe('снаружи')
    expect((await linked.write('note.md', 'мой', doc?.mtimeMs ?? null, true)).ok).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('мой')
  })

  it('копия с оригиналом: читаем и пишем оригинал, копия догоняет', async () => {
    const source = path.join(dir, 'outside.md')
    await fs.writeFile(source, 'оригинал')
    await fs.writeFile(path.join(root, 'attachments/outside.md'), 'старая копия')
    linked.track([{ relPath: 'attachments/outside.md', source }])
    const doc = await linked.read('attachments/outside.md')
    expect(doc).toMatchObject({ text: 'оригинал', path: source })
    expect((await linked.write('attachments/outside.md', 'правка', doc?.mtimeMs ?? null)).ok).toBe(true)
    expect(await fs.readFile(source, 'utf8')).toBe('правка')
    expect(await fs.readFile(path.join(root, 'attachments/outside.md'), 'utf8')).toBe('правка')
  })

  it('оригинал поменялся на диске — копия перекопирована по inotify', async () => {
    const source = path.join(dir, 'live.txt')
    await fs.writeFile(source, 'v1')
    await fs.writeFile(path.join(root, 'attachments/live.txt'), 'v1')
    linked.track([{ relPath: 'attachments/live.txt', source }])
    await new Promise((r) => setTimeout(r, 300))
    await fs.writeFile(source, 'v2')
    const copy = path.join(root, 'attachments/live.txt')
    for (let i = 0; i < 40 && (await fs.readFile(copy, 'utf8')) !== 'v2'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(await fs.readFile(copy, 'utf8')).toBe('v2')
  })

  it('большой файл не читается целиком', async () => {
    await fs.writeFile(path.join(root, 'big.log'), 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(await linked.read('big.log')).toMatchObject({ tooLarge: true, text: '' })
  })
})

describe('вид файла', () => {
  const node = { id: 'n', type: 'file', file: 'a.md', x: 0, y: 0, width: 1, height: 1, extra: {} } as DocNode
  it('по умолчанию содержимое, плашка — флагом, обратно — без следа', () => {
    expect(fileView(node)).toBe('content')
    const chip = { ...node, extra: withFileView(node.extra, 'chip') }
    expect(fileView(chip)).toBe('chip')
    expect(withFileView(chip.extra, 'content')).toEqual({})
  })
})
