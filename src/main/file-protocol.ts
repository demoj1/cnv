import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { FILE_PROTOCOL } from '@shared/app'
import { mimeFor, resolveRealInRoot } from './paths'
import type { Workspace } from './workspace'

export function registerFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

export function fileUrl(relPath: string): string {
  return `${FILE_PROTOCOL}://workspace/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

export function handleFileProtocol(workspace: Workspace): void {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'workspace') return new Response('bad host', { status: 400 })
    const root = workspace.rootPath
    if (!root) return new Response('workspace closed', { status: 404 })

    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = await resolveRealInRoot(root, relPath)
    if (!abs) return new Response('forbidden', { status: 403 })

    const response = await net.fetch(pathToFileURL(abs).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Type', mimeFor(abs))
    headers.set('Cache-Control', 'no-cache')
    return new Response(response.body, { status: response.status, headers })
  })
}
