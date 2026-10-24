import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceKeys, verifyPeer } from '../../src/main/device-identity'

describe('ключи устройства для порталов', () => {
  it('создаются один раз, переживают перезапуск, подпись проверяется, подделка — нет', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-dev-'))
    try {
      const file = path.join(dir, 'device-key.pem')
      const a = new DeviceKeys(file, () => 'Ноутбук')
      const again = new DeviceKeys(file, () => 'Ноутбук')
      expect(again.fingerprint).toBe(a.fingerprint)
      expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')

      const sig = a.sign('nonce-123')
      expect(verifyPeer(a.publicKey, a.fingerprint, 'nonce-123', sig)).toBe(true)
      expect(verifyPeer(a.publicKey, a.fingerprint, 'nonce-124', sig)).toBe(false)
      const other = new DeviceKeys(path.join(dir, 'other.pem'), () => 'Чужой')
      // Чужой ключ под нашим отпечатком не пройдёт.
      expect(verifyPeer(other.publicKey, a.fingerprint, 'nonce-123', other.sign('nonce-123'))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
