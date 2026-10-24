import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { LinkedFile, TextFileContent, TextFileWrite } from '@shared/api'
import { resolveRealInRoot } from './paths'
import type { Workspace } from './workspace'

/** Больше этого текст в ноде не показываем: холст — не просмотрщик логов на гигабайт. */
export const TEXT_FILE_MAX = 2 * 1024 * 1024

/**
 * Оригиналы файлов-копий снаружи workspace: следим за ними через inotify (chokidar поверх
 * fs.watch), а не опросом. Оригинал поменялся — перекопировать во вложения; саму копию
 * уже заметит watcher workspace и скажет окну перерисовать ноду.
 *
 * Текстовые файлы ещё и читаются и пишутся отсюда: правка карточки уходит в оригинал, если
 * он есть, — карточка показывает файл на диске, а копия лишь его тень.
 */
export class LinkedFiles {
  private watcher: FSWatcher | null = null
  /** Оригинал → копии во вложениях, которые за ним следуют. */
  private bySource = new Map<string, Set<string>>()
  private sourceByCopy = new Map<string, string>()

  constructor(private readonly workspace: Workspace) {}

  /** Полный список связей с холста: лишнее перестаём слушать, новое — слушаем и сверяем сразу. */
  track(files: readonly LinkedFile[]): void {
    const next = new Map<string, Set<string>>()
    const byCopy = new Map<string, string>()
    for (const f of files) {
      if (!f.source || !path.isAbsolute(f.source)) continue
      const set = next.get(f.source) ?? new Set<string>()
      set.add(f.relPath)
      next.set(f.source, set)
      byCopy.set(f.relPath, f.source)
    }
    const added = [...next.keys()].filter((s) => !this.bySource.has(s))
    const removed = [...this.bySource.keys()].filter((s) => !next.has(s))
    this.bySource = next
    this.sourceByCopy = byCopy

    if (removed.length > 0) void this.watcher?.unwatch(removed)
    if (added.length === 0) return
    if (!this.watcher) {
      this.watcher = chokidar.watch(added, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      })
      // Редакторы пишут через временный файл и rename — это unlink+add, а не change.
      this.watcher.on('change', (abs) => void this.refresh(abs))
      this.watcher.on('add', (abs) => void this.refresh(abs))
    } else {
      this.watcher.add(added)
    }
    // Пока cnv был закрыт, оригинал мог уйти вперёд.
    for (const source of added) void this.refresh(source)
  }

  sourceOf(relPath: string): string | undefined {
    return this.sourceByCopy.get(relPath)
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    this.bySource.clear()
    this.sourceByCopy.clear()
  }

  private async refresh(source: string): Promise<void> {
    for (const relPath of this.bySource.get(source) ?? []) {
      await this.workspace.refreshCopy(relPath, source).catch(() => undefined)
    }
  }

  /** Где лежит настоящий текст: оригинал, если копия за ним следует и он жив, иначе сама копия. */
  private async target(relPath: string): Promise<string | null> {
    const source = this.sourceOf(relPath)
    if (source && (await fs.stat(source).catch(() => null))) return source
    const root = this.workspace.rootPath
    return root ? resolveRealInRoot(root, relPath) : null
  }

  async read(relPath: string): Promise<TextFileContent | null> {
    const abs = await this.target(relPath)
    if (!abs) return null
    try {
      const st = await fs.stat(abs)
      if (st.size > TEXT_FILE_MAX) return { text: '', mtimeMs: st.mtimeMs, path: abs, tooLarge: true }
      return { text: await fs.readFile(abs, 'utf8'), mtimeMs: st.mtimeMs, path: abs }
    } catch {
      return null
    }
  }

  /**
   * Записать текст файла. `baseMtimeMs` — версия, с которой человек начинал правку: если на
   * диске уже другая (файл поправили снаружи), не затираем, а возвращаем конфликт с тем,
   * что там сейчас. `force` — перезаписать всё равно.
   */
  async write(
    relPath: string,
    text: string,
    baseMtimeMs: number | null,
    force = false
  ): Promise<TextFileWrite> {
    const abs = await this.target(relPath)
    if (!abs) return { ok: false, error: 'файла нет' }
    const st = await fs.stat(abs).catch(() => null)
    if (st && !force && baseMtimeMs !== null && Math.abs(st.mtimeMs - baseMtimeMs) > 1) {
      const current = await fs.readFile(abs, 'utf8').catch(() => '')
      return { ok: false, conflict: { text: current, mtimeMs: st.mtimeMs } }
    }
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`)
    try {
      await fs.writeFile(tmp, text, 'utf8')
      if (st) await fs.chmod(tmp, st.mode & 0o7777)
      await fs.rename(tmp, abs)
    } catch (e) {
      await fs.rm(tmp, { force: true })
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const source = this.sourceOf(relPath)
    if (source === abs) await this.workspace.refreshCopy(relPath, source).catch(() => undefined)
    const after = await fs.stat(abs)
    return { ok: true, mtimeMs: after.mtimeMs }
  }
}
