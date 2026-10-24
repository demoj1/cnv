import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Личность этого cnv для порталов: пара ключей Ed25519, создаётся один раз и лежит в папке
 * данных. Публичный ключ — визитка («Ноутбук Пети · AB12-CD34-EF56»), приватным cnv
 * подписывает приветствие при соединении: подделать чужую визитку нельзя.
 */
export interface DeviceIdentity {
  name: string
  /** Публичный ключ, SPKI DER в base64. */
  publicKey: string
  /** sha256 от публичного ключа, hex. */
  fingerprint: string
}

export class DeviceKeys {
  private privateKey: crypto.KeyObject
  readonly publicKey: string
  readonly fingerprint: string

  constructor(
    file: string,
    private nameOf: () => string
  ) {
    let pem: string | null = null
    try {
      pem = fs.readFileSync(file, 'utf8')
    } catch {
      // ещё нет — создадим
    }
    if (pem) {
      this.privateKey = crypto.createPrivateKey(pem)
    } else {
      const pair = crypto.generateKeyPairSync('ed25519')
      this.privateKey = pair.privateKey
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    }
    const der = crypto.createPublicKey(this.privateKey).export({ type: 'spki', format: 'der' })
    this.publicKey = der.toString('base64')
    this.fingerprint = crypto.createHash('sha256').update(der).digest('hex')
  }

  identity(): DeviceIdentity {
    return { name: this.nameOf(), publicKey: this.publicKey, fingerprint: this.fingerprint }
  }

  /** Подпись строки (base64). */
  sign(data: string): string {
    return crypto.sign(null, Buffer.from(data, 'utf8'), this.privateKey).toString('base64')
  }
}

/** Проверить подпись чужого cnv и что отпечаток — от этого же ключа. */
export function verifyPeer(publicKey: string, fingerprint: string, data: string, signature: string): boolean {
  try {
    const der = Buffer.from(publicKey, 'base64')
    if (crypto.createHash('sha256').update(der).digest('hex') !== fingerprint) return false
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** Имя cnv для той стороны: из настроек, иначе имя компьютера. */
export const defaultDeviceName = (): string => os.hostname()
