import crypto from 'node:crypto'
import type { Caller } from './protocol'

const newToken = (): string => crypto.randomBytes(24).toString('base64url')

/**
 * Токен у каждого терминала свой: по нему сервер знает, из какой карточки пришёл
 * агент. Плюс один общий — для клиентов снаружи холста, у них ноды нет.
 */
export class TokenRegistry {
  readonly appToken = newToken()
  private byToken = new Map<string, string>()
  private byNode = new Map<string, string>()

  issue(nodeId: string): string {
    this.revoke(nodeId)
    const token = newToken()
    this.byToken.set(token, nodeId)
    this.byNode.set(nodeId, token)
    return token
  }

  revoke(nodeId: string): void {
    const token = this.byNode.get(nodeId)
    if (!token) return
    this.byNode.delete(nodeId)
    this.byToken.delete(token)
  }

  resolve(token: string): Caller | null {
    if (safeEqual(token, this.appToken)) return { nodeId: null }
    const nodeId = this.byToken.get(token)
    return nodeId ? { nodeId } : null
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
