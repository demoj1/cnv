import { ipcMain, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentMethod, AgentMethods, AgentRequest, AgentResponse } from '@shared/agent'
import { callerScope } from './protocol'

/** Дольше этого холст думать не должен: значит, окно повисло или ещё грузится. */
const TIMEOUT_MS = 15_000

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Запрос → ответ к холсту в renderer поверх обычного IPC, с таймаутом. */
export class CanvasBridge {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private ready = false

  constructor(private readonly host: () => WebContents | null) {
    ipcMain.on(IPC.agentResponse, (_e, response: AgentResponse) => {
      const entry = this.pending.get(response.id)
      if (!entry) return
      this.pending.delete(response.id)
      clearTimeout(entry.timer)
      if (response.ok) entry.resolve(response.result)
      else entry.reject(new Error(response.error))
    })
  }

  /** Холст подписался на запросы — до этого звать бесполезно. */
  setReady(ready: boolean): void {
    this.ready = ready
    if (!ready) {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('холст перезагрузился'))
        this.pending.delete(id)
      }
    }
  }

  call<M extends AgentMethod>(
    method: M,
    params: AgentMethods[M]['params']
  ): Promise<AgentMethods[M]['result']> {
    const host = this.host()
    if (!host || host.isDestroyed() || !this.ready) {
      return Promise.reject(new Error('холст ещё не готов — окно cnv не открыто или грузится'))
    }
    const id = this.nextId++
    const caller = callerScope.getStore()
    const request: AgentRequest<M> = { id, method, params, ...(caller ? { caller } : {}) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`холст не ответил на ${method} за ${TIMEOUT_MS / 1000} с`))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      host.send(IPC.agentRequest, request)
    })
  }
}
