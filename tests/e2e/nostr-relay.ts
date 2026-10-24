import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Мини-ретранслятор Nostr для тестов порталов: в CI нельзя зависеть от публичных серверов.
 * Подписи не проверяет — только раздаёт события подписчикам по фильтрам (kinds, #теги, since).
 */
interface NostrEvent {
  id: string
  kind: number
  created_at: number
  tags: string[][]
}

type Filter = Record<string, unknown> & { kinds?: number[]; since?: number }

const matches = (ev: NostrEvent, f: Filter): boolean => {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since !== undefined && ev.created_at < f.since) return false
  for (const [key, values] of Object.entries(f)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue
    const letter = key.slice(1)
    if (!ev.tags.some((t) => t[0] === letter && values.includes(t[1]))) return false
  }
  return true
}

export async function startNostrRelay(): Promise<{ url: string; close(): Promise<void> }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const subs = new Map<WebSocket, Map<string, Filter[]>>()
  const recent: NostrEvent[] = []

  server.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('close', () => subs.delete(ws))
    ws.on('message', (raw) => {
      let msg: unknown[]
      try {
        msg = JSON.parse(String(raw)) as unknown[]
      } catch {
        return
      }
      const [type] = msg
      if (type === 'EVENT') {
        const ev = msg[1] as NostrEvent
        recent.push(ev)
        if (recent.length > 500) recent.shift()
        ws.send(JSON.stringify(['OK', ev.id, true, '']))
        for (const [peer, mine] of subs) {
          for (const [subId, filters] of mine) {
            if (filters.some((f) => matches(ev, f))) peer.send(JSON.stringify(['EVENT', subId, ev]))
          }
        }
      } else if (type === 'REQ') {
        const subId = msg[1] as string
        const filters = msg.slice(2) as Filter[]
        subs.get(ws)?.set(subId, filters)
        for (const ev of recent)
          if (filters.some((f) => matches(ev, f))) ws.send(JSON.stringify(['EVENT', subId, ev]))
        ws.send(JSON.stringify(['EOSE', subId]))
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(msg[1] as string)
      }
    })
  })

  const { port } = server.address() as { port: number }
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const ws of server.clients) ws.terminate()
        server.close(() => resolve())
      })
  }
}
