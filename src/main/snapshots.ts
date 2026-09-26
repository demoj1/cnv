import { app, nativeImage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const dir = (): string => path.join(app.getPath('userData'), 'snapshots')

export const snapshotKey = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex').slice(0, 32)

export async function saveSnapshot(key: string, dataUrl: string): Promise<string> {
  const image = nativeImage.createFromDataURL(dataUrl)
  const file = path.join(dir(), `${snapshotKey(key)}.png`)
  await fs.mkdir(dir(), { recursive: true })
  await fs.writeFile(file, image.toPNG())
  return file
}

export async function snapshotDataUrl(key: string): Promise<string | null> {
  const file = path.join(dir(), `${snapshotKey(key)}.png`)
  try {
    const buf = await fs.readFile(file)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
