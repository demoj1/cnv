import { useEffect, useState } from 'react'
import type { CanvasFileInfo, WorkspaceInfo } from '@shared/api'

interface Props {
  workspace: WorkspaceInfo | null
  current: string | null
  onOpen(relPath: string): void
  onChooseWorkspace(): void
}

export function Sidebar({ workspace, current, onOpen, onChooseWorkspace }: Props): React.JSX.Element {
  const [files, setFiles] = useState<CanvasFileInfo[]>([])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!workspace) return
    void window.api.workspace.list().then(setFiles)
    return window.api.workspace.onListChanged(setFiles)
  }, [workspace])

  const list = workspace ? files : []

  const create = async (): Promise<void> => {
    const info = await window.api.canvas.create('Новый канвас')
    setFiles(await window.api.workspace.list())
    onOpen(info.relPath)
  }

  const remove = async (relPath: string): Promise<void> => {
    await window.api.canvas.remove(relPath)
    setFiles(await window.api.workspace.list())
  }

  const commitRename = async (relPath: string): Promise<void> => {
    const name = draft.trim()
    setRenaming(null)
    if (!name) return
    const dir = relPath.includes('/') ? `${relPath.slice(0, relPath.lastIndexOf('/'))}/` : ''
    const info = await window.api.canvas.rename(relPath, `${dir}${name}.canvas`)
    setFiles(await window.api.workspace.list())
    if (current === relPath) onOpen(info.relPath)
  }

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar__head">
        <button
          type="button"
          className="sidebar__workspace"
          onClick={onChooseWorkspace}
          title="Сменить папку"
        >
          {workspace?.name ?? 'Открыть папку…'}
        </button>
        {workspace && (
          <button type="button" onClick={() => void create()} title="Новый канвас">
            +
          </button>
        )}
      </div>
      <ul className="sidebar__list">
        {list.map((f) => (
          <li
            key={f.relPath}
            className={f.relPath === current ? 'sidebar__item sidebar__item--active' : 'sidebar__item'}
            data-canvas={f.relPath}
          >
            {renaming === f.relPath ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitRename(f.relPath)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(f.relPath)
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="sidebar__open"
                onClick={() => onOpen(f.relPath)}
                onDoubleClick={() => {
                  setRenaming(f.relPath)
                  setDraft(f.name)
                }}
              >
                {f.name}
              </button>
            )}
            <button
              type="button"
              className="sidebar__remove"
              onClick={() => void remove(f.relPath)}
              title="Удалить"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
