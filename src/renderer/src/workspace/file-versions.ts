import { useEffect, useState } from 'react'

/**
 * Версии файлов workspace: копия обновилась с оригинала — номер растёт, и картинка или PDF
 * перечитывают файл (`?v=` в адресе; протокол файлов запрос игнорирует, кеш — нет).
 */
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

export function bumpFileVersion(relPath: string): void {
  versions.set(relPath, (versions.get(relPath) ?? 0) + 1)
  for (const l of listeners) l()
}

export function useFileVersion(relPath: string): number {
  const [version, setVersion] = useState(versions.get(relPath) ?? 0)
  useEffect(() => {
    const update = (): void => setVersion(versions.get(relPath) ?? 0)
    listeners.add(update)
    update()
    return () => {
      listeners.delete(update)
    }
  }, [relPath])
  return version
}

/** Адрес файла с версией — чтобы обновлённая копия не бралась из кеша. */
export const versionedUrl = (url: string, version: number): string =>
  version > 0 ? `${url}?v=${version}` : url
