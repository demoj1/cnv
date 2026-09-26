import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import { CANVAS_EXT } from '@shared/app'
import type { ExternalChange, WorkspaceInfo } from '@shared/api'
import { resolveInRoot, toRelative, uniqueName } from './paths'

export class WorkspaceError extends Error {}

export class Workspace extends EventEmitter {
  private root: string | null = null
  private watcher: FSWatcher | null = null
  private selfWrites = new Map<string, string>()

  get info(): WorkspaceInfo | null {
    return this.root ? { root: this.root, name: path.basename(this.root) } : null
  }

  get rootPath(): string | null {
    return this.root
  }

  async open(root: string): Promise<WorkspaceInfo> {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) throw new WorkspaceError(`не папка: ${root}`)
    await this.close()
    this.root = path.resolve(root)
    this.watch()
    const info = this.info
    if (!info) throw new WorkspaceError('workspace не открылся')
    this.emit('opened', info)
    return info
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    this.root = null
  }

  private requireRoot(): string {
    if (!this.root) throw new WorkspaceError('workspace не открыт')
    return this.root
  }

  private resolve(relPath: string): string {
    const abs = resolveInRoot(this.requireRoot(), relPath)
    if (!abs) throw new WorkspaceError(`путь вне workspace: ${relPath}`)
    return abs
  }

  private watch(): void {
    const root = this.requireRoot()
    this.watcher = chokidar.watch(root, {
      ignored: (p) => path.basename(p).startsWith('.'),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    const relOf = (abs: string): string | null => toRelative(root, abs)
    const isCanvas = (rel: string): boolean => rel.endsWith(CANVAS_EXT)

    this.watcher.on('unlink', (abs) => {
      const rel = relOf(abs)
      if (rel && isCanvas(rel)) this.emitExternal({ relPath: rel, kind: 'unlink', mtimeMs: 0 })
    })
    this.watcher.on('change', (abs) => {
      const rel = relOf(abs)
      if (!rel || !isCanvas(rel)) return
      // Сравниваем содержимое, а не mtime: своё сохранение и чужая правка могут попасть
      // в одну секунду, и по времени их не различить.
      void Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)]).then(([text, st]) => {
        if (this.selfWrites.get(rel) === digest(text)) return
        this.selfWrites.delete(rel)
        this.emitExternal({ relPath: rel, kind: 'change', mtimeMs: st.mtimeMs })
      })
    })
  }

  private emitExternal(change: ExternalChange): void {
    this.emit('external-change', change)
  }

  async read(relPath: string): Promise<{ relPath: string; text: string; mtimeMs: number }> {
    const abs = this.resolve(relPath)
    const [text, st] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
    return { relPath, text, mtimeMs: st.mtimeMs }
  }

  async write(relPath: string, text: string): Promise<{ mtimeMs: number }> {
    const abs = this.resolve(relPath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`)
    const handle = await fs.open(tmp, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, abs)
    const st = await fs.stat(abs)
    this.selfWrites.set(relPath, digest(text))
    return { mtimeMs: st.mtimeMs }
  }

  async importPath(
    sourcePath: string,
    attachmentsDir: string
  ): Promise<{ relPath: string; copied: boolean }> {
    const root = this.requireRoot()
    const inside = toRelative(root, path.resolve(sourcePath))
    if (inside) return { relPath: inside, copied: false }
    const dir = path.join(root, attachmentsDir)
    await fs.mkdir(dir, { recursive: true })
    const name = await uniqueName(dir, path.basename(sourcePath))
    await fs.copyFile(sourcePath, path.join(dir, name))
    return { relPath: `${attachmentsDir}/${name}`, copied: true }
  }

  async importBytes(
    fileName: string,
    bytes: Uint8Array,
    attachmentsDir: string
  ): Promise<{ relPath: string; copied: boolean }> {
    const root = this.requireRoot()
    const dir = path.join(root, attachmentsDir)
    await fs.mkdir(dir, { recursive: true })
    const name = await uniqueName(dir, path.basename(fileName) || `file-${Date.now()}`)
    await fs.writeFile(path.join(dir, name), bytes)
    return { relPath: `${attachmentsDir}/${name}`, copied: true }
  }
}

const digest = (text: string): string => crypto.createHash('sha1').update(text).digest('hex')

export const defaultWorkspaceRoot = (): string => path.join(os.homedir(), 'Canvases')
