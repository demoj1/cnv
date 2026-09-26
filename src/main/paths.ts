import path from 'node:path'
import fs from 'node:fs/promises'

export function toRelative(root: string, target: string): string | null {
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

export function resolveInRoot(root: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null
  const abs = path.resolve(root, relPath)
  return toRelative(root, abs) === null ? null : abs
}

export async function resolveRealInRoot(root: string, relPath: string): Promise<string | null> {
  const abs = resolveInRoot(root, relPath)
  if (!abs) return null
  try {
    const real = await fs.realpath(abs)
    const realRoot = await fs.realpath(root)
    return toRelative(realRoot, real) === null ? null : real
  } catch {
    return null
  }
}

export async function uniqueName(dir: string, fileName: string): Promise<string> {
  const ext = path.extname(fileName)
  const base = path.basename(fileName, ext)
  let candidate = fileName
  let n = 1
  for (;;) {
    try {
      await fs.access(path.join(dir, candidate))
      candidate = `${base}-${n++}${ext}`
    } catch {
      return candidate
    }
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.canvas': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav'
}

export const mimeFor = (file: string): string =>
  MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
