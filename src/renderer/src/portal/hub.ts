import { joinRoom, type JsonValue, type Room } from 'trystero'
import type { CanvasDoc } from '@core/document'
import { ackTimeoutMs, portalMembers, portalSpec, type PortalSpec } from '@core/portal'
import type {
  DeviceIdentityView,
  PortalDelivery,
  PortalMemberView,
  PortalView,
  PortalWireMessage
} from '@shared/portal'

/**
 * Порталы между cnv живут здесь, в окне холста: WebRTC есть только тут. На каждый портал —
 * своя комната Trystero: знакомство через публичные Nostr-ретрансляторы (комната — хеш
 * ключа, приглашения зашифрованы самим ключом), дальше — прямой канал между машинами.
 *
 * Портал — пара: второй собеседник с тем же ключом не пускается. Кто на той стороне,
 * проверяем подписью его ключа устройства; впервые увиденный cnv ждёт, пока человек его
 * пустит, — после этого отпечаток запоминается в портале.
 */

const APP_ID = 'cnv-portal-1'
const PING_MS = 5000

interface Hello {
  v: 1
  name: string
  publicKey: string
  fingerprint: string
  nonce: string
  version?: string
}

type Wire =
  | { t: 'roster'; members: PortalMemberView[] }
  /** «Пришли свой состав»: он мог прийти раньше, чем мы узнали собеседника. */
  | { t: 'want-roster' }
  | { t: 'msg'; message: PortalWireMessage }
  | { t: 'ack'; id: string; delivery: PortalDelivery }

interface Connection {
  id: string
  key: string
  room: Room
  send: (data: Wire, target?: string) => Promise<unknown>
  /** Собеседник после рукопожатия: peerId Trystero → кто это. */
  hellos: Map<string, Hello>
  peerId: string | null
  view: PortalView
  pingTimer: ReturnType<typeof setInterval> | null
  acks: Map<string, (d: PortalDelivery) => void>
  /**
   * Очередь отправки: письма уходят строго по одному. Иначе большое письмо, которое канал
   * режет на куски, обгоняет короткое, отправленное следом, — порядок ломается.
   */
  outbox: Promise<unknown>
  /** Последний отправленный состав — шлём заново, только если он поменялся. */
  sentRoster: string
}

export interface PortalHubDeps {
  identity(): Promise<DeviceIdentityView>
  sign(data: string): Promise<string>
  verify(publicKey: string, fingerprint: string, data: string, signature: string): Promise<boolean>
  /** Письмо с той стороны — агенту здесь (через main). */
  deliver(
    portalId: string,
    label: string,
    peerName: string,
    message: PortalWireMessage
  ): Promise<PortalDelivery>
  /** Пришло письмо — огонёк от портала к адресату. */
  onDelivered?(portalId: string, toNodeId: string): void
  relays(): string[]
}

const randomNonce = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

async function roomOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cnv-portal:${key}`))
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const labelOf = (spec: PortalSpec): string => spec.label ?? 'Портал'

export class PortalHub {
  private connections = new Map<string, Connection>()
  private joining = new Set<string>()
  private listeners = new Set<() => void>()
  private doc: CanvasDoc | null = null
  /** Кого человек не пустил в этой сессии: отпечаток → портал. */
  private rejected = new Map<string, Set<string>>()
  /** Порталы, которые не удалось открыть, — с причиной (видна на ноде). */
  private failed = new Map<string, string>()
  /** Ретрансляторы, с которыми открыты порталы. */
  private relaysSeen = ''

  constructor(private deps: PortalHubDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  views(): PortalView[] {
    return [...this.connections.values()].map((c) => c.view)
  }

  view(id: string): PortalView | undefined {
    const c = this.connections.get(id)
    if (c) return c.view
    const error = this.failed.get(id)
    return error ? { id, label: 'Портал', status: 'error', remote: [], error } : undefined
  }

  /** Холст поменялся: открыть новые порталы, закрыть удалённые, обновить состав и доверие. */
  sync(doc: CanvasDoc): void {
    this.doc = doc
    const alive = new Set<string>()
    for (const node of doc.nodes) {
      const spec = portalSpec(node)
      if (!spec) continue
      alive.add(node.id)
      // Выключен — рвём соединение и пару не ищем; включат — sync откроет заново.
      if (spec.off) {
        if (this.connections.has(node.id)) this.close(node.id)
        this.failed.delete(node.id)
        continue
      }
      const conn = this.connections.get(node.id)
      if (conn && conn.key !== spec.key) this.close(node.id)
      if (!this.connections.has(node.id)) {
        if (spec.key && !this.joining.has(node.id) && !this.failed.has(node.id)) void this.open(node.id, spec)
        continue
      }
      const c = this.connections.get(node.id)!
      if (c.view.label !== labelOf(spec)) this.update(c, { label: labelOf(spec) })
      // Человек пустил ту сторону — переходим к разговору.
      const peer = c.peerId ? c.hellos.get(c.peerId) : undefined
      if (
        c.view.status === 'confirm' &&
        peer &&
        spec.trusted.some((t) => t.fingerprint === peer.fingerprint)
      ) {
        this.update(c, { status: 'connected' })
        if (c.peerId) void c.send({ t: 'want-roster' }, c.peerId)
      }
      if (c.view.status === 'connected') this.sendRoster(c)
    }
    for (const id of [...this.connections.keys()]) if (!alive.has(id)) this.close(id)
  }

  /** Человек не пустил ту сторону: разговора не будет, пока он не передумает (сбросить). */
  reject(portalId: string): void {
    const c = this.connections.get(portalId)
    const peer = c?.peerId ? c.hellos.get(c.peerId) : undefined
    if (!c || !peer) return
    const banned = this.rejected.get(portalId) ?? new Set<string>()
    banned.add(peer.fingerprint)
    this.rejected.set(portalId, banned)
    this.update(c, { status: 'rejected', remote: [] })
  }

  /** Начать поиск заново (после отказа или ошибки). */
  retry(portalId: string): void {
    this.rejected.delete(portalId)
    this.failed.delete(portalId)
    this.close(portalId)
    if (this.doc) this.sync(this.doc)
  }

  /** Письмо на ту сторону; ждём подтверждения доставки. */
  async send(portalId: string, message: PortalWireMessage): Promise<PortalDelivery> {
    const c = this.connections.get(portalId)
    if (!c || c.view.status !== 'connected' || !c.peerId) {
      const node = this.doc?.nodes.find((n) => n.id === portalId)
      const off = node ? portalSpec(node)?.off : false
      return { ok: false, error: off ? 'портал выключен человеком' : 'портал не на связи' }
    }
    const peerId = c.peerId
    const timeout = ackTimeoutMs(JSON.stringify(message).length)
    let arm: () => void = () => undefined
    const delivered = new Promise<PortalDelivery>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      c.acks.set(message.id, (d) => {
        if (timer) clearTimeout(timer)
        resolve(d)
      })
      // Часы запускаем, только когда письмо ушло целиком: 8 МБ передаются не мгновенно.
      arm = () => {
        if (!c.acks.has(message.id)) return
        timer = setTimeout(() => {
          c.acks.delete(message.id)
          resolve({
            ok: false,
            unconfirmed: true,
            error: `письмо ушло, но та сторона не подтвердила доставку за ${Math.round(timeout / 1000)} с`
          })
        }, timeout)
      }
    })
    const sent = c.outbox.then(() => c.send({ t: 'msg', message }, peerId))
    c.outbox = sent.catch(() => undefined)
    try {
      await sent
    } catch (e) {
      c.acks.delete(message.id)
      return { ok: false, error: `не ушло в портал: ${e instanceof Error ? e.message : String(e)}` }
    }
    arm()
    return delivered
  }

  /** Сменились ретрансляторы (настройки догрузились или их поправили) — переоткрыть порталы. */
  relaysChanged(): void {
    const now = JSON.stringify(this.deps.relays())
    if (now === this.relaysSeen) return
    this.relaysSeen = now
    for (const id of [...this.connections.keys()]) this.close(id)
    this.failed.clear()
    if (this.doc) this.sync(this.doc)
  }

  closeAll(): void {
    for (const id of [...this.connections.keys()]) this.close(id)
  }

  private publish(): void {
    for (const l of this.listeners) l()
  }

  private update(c: Connection, patch: Partial<PortalView>): void {
    c.view = { ...c.view, ...patch }
    this.publish()
  }

  private spec(id: string): PortalSpec | null {
    const node = this.doc?.nodes.find((n) => n.id === id)
    return node ? portalSpec(node) : null
  }

  private async open(id: string, spec: PortalSpec): Promise<void> {
    this.joining.add(id)
    try {
      const me = await this.deps.identity()
      const roomId = await roomOf(spec.key)
      // Пока считали хеш, портал могли удалить или сменить ключ.
      const current = this.spec(id)
      if (!current || current.key !== spec.key || this.connections.has(id)) return

      const hellos = new Map<string, Hello>()
      const relays = this.deps.relays()
      this.relaysSeen = JSON.stringify(relays)
      const room = joinRoom(
        {
          appId: APP_ID,
          password: spec.key,
          ...(relays.length > 0 ? { relayConfig: { urls: relays } } : {})
        },
        roomId,
        {
          handshakeTimeoutMs: 20_000,
          // Приглашения обменялись, а прямой канал не пробился — обычно строгий NAT (мобильный,
          // корпоративный), нужен TURN. Честно говорим об этом на ноде, а не «ищем» вечно.
          onJoinError: (details) => {
            const c = this.connections.get(id)
            if (!c || c.view.status === 'connected') return
            const reason = String(details.error)
            this.update(c, {
              status: 'error',
              error: /handshake|password/i.test(reason)
                ? `та сторона не прошла проверку (${reason})`
                : 'прямое соединение не пробилось — похоже на строгий NAT, нужен TURN'
            })
          },
          onPeerHandshake: async (peerId, send, receive, isInitiator) => {
            // Портал — пара: пока на связи одна сторона, вторую не пускаем.
            const c = this.connections.get(id)
            if (c?.peerId && c.peerId !== peerId) throw new Error('портал уже занят')
            const hello: Hello = { v: 1, ...me, nonce: randomNonce() }
            let peer: Hello
            const json = (v: unknown): JsonValue => v as JsonValue
            if (isInitiator) {
              await send(json(hello))
              peer = (await receive()).data as unknown as Hello
              await send({ sig: await this.deps.sign(`${peer.nonce}|${roomId}`) })
            } else {
              peer = (await receive()).data as unknown as Hello
              await send(json(hello))
            }
            const { sig } = (await receive()).data as unknown as { sig: string }
            if (!isInitiator) await send({ sig: await this.deps.sign(`${peer.nonce}|${roomId}`) })
            const ok = await this.deps.verify(
              peer.publicKey,
              peer.fingerprint,
              `${hello.nonce}|${roomId}`,
              sig
            )
            if (!ok) throw new Error('подпись той стороны не сошлась')
            hellos.set(peerId, peer)
          }
        }
      )
      const action = room.makeAction<JsonValue>('cnv')
      const conn: Connection = {
        id,
        key: spec.key,
        room,
        send: (data, target) => action.send(data as unknown as JsonValue, target ? { target } : undefined),
        hellos,
        peerId: null,
        view: { id, label: labelOf(spec), status: 'searching', remote: [] },
        pingTimer: null,
        acks: new Map(),
        outbox: Promise.resolve(),
        sentRoster: ''
      }
      this.connections.set(id, conn)
      this.publish()

      room.onPeerJoin = (peerId) => {
        const peer = hellos.get(peerId)
        if (!peer || (conn.peerId && conn.peerId !== peerId)) return
        conn.peerId = peerId
        const trusted = this.spec(id)?.trusted.some((t) => t.fingerprint === peer.fingerprint) ?? false
        const banned = this.rejected.get(id)?.has(peer.fingerprint) ?? false
        this.update(conn, {
          status: banned ? 'rejected' : trusted ? 'connected' : 'confirm',
          peer: {
            name: peer.name,
            fingerprint: peer.fingerprint,
            ...(typeof peer.version === 'string' ? { version: peer.version.slice(0, 32) } : {})
          },
          remote: []
        })
        conn.sentRoster = ''
        if (trusted && !banned) this.sendRoster(conn)
        void conn.send({ t: 'want-roster' }, peerId)
        conn.pingTimer = setInterval(() => {
          void room.ping(peerId).then(
            (ms) => this.update(conn, { rttMs: Math.round(ms) }),
            () => undefined
          )
        }, PING_MS)
      }

      room.onPeerLeave = (peerId) => {
        if (conn.peerId !== peerId) return
        conn.peerId = null
        if (conn.pingTimer) clearInterval(conn.pingTimer)
        conn.pingTimer = null
        for (const resolve of conn.acks.values()) resolve({ ok: false, error: 'та сторона ушла' })
        conn.acks.clear()
        conn.view = { id: conn.view.id, label: conn.view.label, status: 'searching', remote: [] }
        this.publish()
      }

      action.onMessage = (data, { peerId }) => void this.onWire(conn, data as unknown as Wire, peerId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[portal]', message)
      const c = this.connections.get(id)
      if (c) this.update(c, { status: 'error', error: message })
      else this.failed.set(id, message)
      this.publish()
    } finally {
      this.joining.delete(id)
    }
  }

  private async onWire(c: Connection, wire: Wire, peerId: string): Promise<void> {
    if (peerId !== c.peerId) return
    // Состав той стороны запоминаем сразу — он приходит, как только там нас пустили, а мы,
    // может, ещё думаем. Показываем его и пишем туда — только когда пустили и мы.
    if (wire.t === 'want-roster') {
      c.sentRoster = ''
      if (c.view.status === 'connected') this.sendRoster(c)
      return
    }
    if (wire.t === 'roster') {
      this.update(c, { remote: Array.isArray(wire.members) ? wire.members.slice(0, 100) : [] })
      return
    }
    // Пока человек не пустил ту сторону — писем от неё не принимаем.
    if (c.view.status !== 'connected') {
      if (wire.t === 'msg') {
        await c.send(
          {
            t: 'ack',
            id: wire.message.id,
            delivery: { ok: false, error: 'та сторона ещё не пустила тебя в портал' }
          },
          peerId
        )
      }
      return
    }
    switch (wire.t) {
      case 'ack':
        c.acks.get(wire.id)?.(wire.delivery)
        c.acks.delete(wire.id)
        return
      case 'msg': {
        const delivery = await this.receive(c, wire.message)
        await c.send({ t: 'ack', id: wire.message.id, delivery }, peerId)
      }
    }
  }

  private async receive(c: Connection, message: PortalWireMessage): Promise<PortalDelivery> {
    // Писать можно только тем, кого человек подключил к порталу: остальной холст частный.
    const members = this.doc ? portalMembers(this.doc, c.id) : []
    const target = members.find((m) => m.id === message.to)
    if (!target) return { ok: false, error: 'адресат не подключён к порталу на этой стороне' }
    if (target.kind !== 'agent') return { ok: false, error: `«${target.name}» — терминал, а не агент` }
    const delivery = await this.deps.deliver(c.id, c.view.label, c.view.peer?.name ?? 'та сторона', message)
    if (delivery.ok) this.deps.onDelivered?.(c.id, target.id)
    return delivery
  }

  private sendRoster(c: Connection): void {
    if (!c.peerId || !this.doc) return
    const members = portalMembers(this.doc, c.id)
    const sig = JSON.stringify(members)
    if (sig === c.sentRoster) return
    c.sentRoster = sig
    void c.send({ t: 'roster', members }, c.peerId)
  }

  private close(id: string): void {
    const c = this.connections.get(id)
    if (!c) return
    this.connections.delete(id)
    if (c.pingTimer) clearInterval(c.pingTimer)
    for (const resolve of c.acks.values()) resolve({ ok: false, error: 'портал закрыт' })
    void c.room.leave()
    this.publish()
  }
}
