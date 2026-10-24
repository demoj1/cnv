/** Порталы между cnv: что ходит по каналу и что видят UI и MCP. */

export interface PortalMemberView {
  id: string
  name: string
  role?: string
  kind: 'agent' | 'terminal'
}

/** Письмо агента через портал. `to` — id ноды на принимающей стороне. */
export interface PortalWireMessage {
  id: string
  from: { id: string; name: string; role?: string }
  to: string
  text: string
  replyTo?: string
  data?: unknown
  files?: { name: string; base64: string }[]
}

export interface PortalDelivery {
  ok: boolean
  error?: string
  /** Адресат печатал прямо сейчас — письмо встанет в его очередь. */
  busy?: boolean
  /**
   * Письмо ушло, но подтверждение не пришло вовремя: оно могло дойти. Переотправлять не
   * надо — та сторона отбросит повтор с тем же id, а новое письмо стало бы дублем.
   */
  unconfirmed?: boolean
}

export type PortalStatus =
  /** Ключа нет или он кривой. */
  | 'idle'
  /** Человек выключил портал. */
  | 'off'
  /** Ждём пару на ретрансляторах. */
  | 'searching'
  /** Та сторона пришла, но человек её ещё не пустил. */
  | 'confirm'
  | 'connected'
  /** Человек не пустил эту сторону. */
  | 'rejected'
  | 'error'

export interface PortalPeerView {
  name: string
  fingerprint: string
  /** Версия cnv на той стороне — старые её не присылают. */
  version?: string
}

export interface PortalView {
  id: string
  label: string
  status: PortalStatus
  peer?: PortalPeerView
  rttMs?: number
  /** Кто подключён к порталу на той стороне — видно, только когда соединены. */
  remote: PortalMemberView[]
  error?: string
}

/** Входящее письмо — main доставляет его агенту на этой стороне. */
export interface PortalIncoming {
  portalId: string
  portalLabel: string
  peerName: string
  message: PortalWireMessage
}

export interface DeviceIdentityView {
  name: string
  publicKey: string
  fingerprint: string
  /** Версия cnv: та сторона видит её в connections портала. */
  version?: string
}
