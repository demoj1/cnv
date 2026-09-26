import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'
import type { DeepPartial } from '@shared/api'

interface PersistedState {
  settings: Settings
  recentWorkspaces: string[]
  lastWorkspace: string | null
}

function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object') {
      out[k] = mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out as T
}

export class SettingsStore extends EventEmitter {
  private file = path.join(app.getPath('userData'), 'settings.json')
  private state: PersistedState = {
    settings: DEFAULT_SETTINGS,
    recentWorkspaces: [],
    lastWorkspace: null
  }
  private writeChain: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedState>
      this.state = {
        settings: mergeDeep(DEFAULT_SETTINGS, (raw.settings ?? {}) as DeepPartial<Settings>),
        recentWorkspaces: Array.isArray(raw.recentWorkspaces) ? raw.recentWorkspaces : [],
        lastWorkspace: typeof raw.lastWorkspace === 'string' ? raw.lastWorkspace : null
      }
    } catch {
      this.state = { settings: DEFAULT_SETTINGS, recentWorkspaces: [], lastWorkspace: null }
    }
  }

  get settings(): Settings {
    return this.state.settings
  }

  get recentWorkspaces(): string[] {
    return this.state.recentWorkspaces
  }

  get lastWorkspace(): string | null {
    return this.state.lastWorkspace
  }

  patch(patch: DeepPartial<Settings>): Settings {
    this.state.settings = mergeDeep(this.state.settings, patch)
    this.persist()
    this.emit('changed', this.state.settings)
    return this.state.settings
  }

  noteWorkspace(root: string): void {
    this.state.lastWorkspace = root
    this.state.recentWorkspaces = [root, ...this.state.recentWorkspaces.filter((r) => r !== root)].slice(
      0,
      12
    )
    this.persist()
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
  }

  async flush(): Promise<void> {
    await this.writeChain
  }
}
