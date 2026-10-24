import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import { isMarkdownFile, isTextFile } from '@core/node-kind'
import { fileSource, fileView } from '@core/ops'
import { resolveFontFamily, textEdit } from '@core/text-edit'
import { useCanvasEnv } from '@renderer/canvas/env'
import { useFileVersion } from '@renderer/workspace/file-versions'
import { renderMarkdown } from './markdown'
import { MarkdownEditor } from './MarkdownEditor'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & FileNode>

const ICONS: [RegExp, string][] = [
  [/^(docx?|odt|rtf|pages)$/, '📄'],
  [/^(xlsx?|ods|csv|tsv|numbers)$/, '📊'],
  [/^(pptx?|odp|key)$/, '📽'],
  [/^(zip|rar|7z|tar|gz|bz2|xz|zst)$/, '📦'],
  [/^(mp3|wav|flac|ogg|m4a|opus)$/, '🎵'],
  [/^(mp4|mkv|mov|webm|avi)$/, '🎬'],
  [/^(txt|md|log|rst|org)$/, '🗒'],
  [/^(json|ya?ml|toml|xml|ini|env)$/, '⚙'],
  [/^(ts|tsx|js|jsx|py|go|rs|c|cpp|h|java|kt|rb|sh|ex|exs|sql)$/, '💻'],
  [/^(stl|step|stp|obj|3mf|f3d|fcstd|blend)$/, '🧊']
]

const iconFor = (ext: string): string => ICONS.find(([re]) => re.test(ext))?.[1] ?? '📎'

const formatSize = (n: number): string =>
  n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`

/** Файл, который не картинка и не PDF: текст — содержимым, прочее — плашкой. */
export function UnknownFileView(props: Props): React.JSX.Element {
  const { node } = props
  if (isTextFile(node.file) && fileView(node) === 'content') return <TextFileView {...props} />
  return <FileChip {...props} />
}

/** Через сколько после последней правки текст уходит в файл. */
const SAVE_MS = 600

/**
 * Текстовый файл с диска, а не копия текста в .canvas: файл поменялся — карточка
 * перечитала его; правка карточки (двойной клик) пишется обратно в файл. Если файл
 * поправили снаружи, пока человек правил тут, — не затираем, а спрашиваем.
 */
function TextFileView({ node, active }: Props): React.JSX.Element {
  const { settings } = useCanvasEnv()
  const version = useFileVersion(node.file)
  const [content, setContent] = useState<{ text: string; mtimeMs: number; path: string } | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'large'>('loading')
  const [conflict, setConflict] = useState<{ text: string; mtimeMs: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const draft = useRef<string | null>(null)
  const base = useRef<number | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRef = useRef<HTMLElement | null>(null)
  const setView = (el: HTMLElement | null): void => {
    viewRef.current = el
  }
  const markdown = isMarkdownFile(node.file)
  const edit = textEdit(node)
  const fontSize = edit?.fontSize ?? settings.nodes.defaultFontSize
  const fontFamily = resolveFontFamily(edit?.fontFamily)

  useEffect(() => {
    let alive = true
    // Пока правим — своё не перетираем чужим: что на диске, решится при записи.
    if (draft.current !== null) return
    void window.api.files.readDoc(node.file).then((doc) => {
      if (!alive) return
      if (!doc) return setState('missing')
      if (doc.tooLarge) return setState('large')
      setContent(doc)
      base.current = doc.mtimeMs
      setState('ready')
    })
    return () => {
      alive = false
    }
  }, [node.file, version])

  const save = async (force = false): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const text = draft.current
    if (text === null) return
    const r = await window.api.files.writeDoc(node.file, text, base.current, force)
    if (r.ok) {
      base.current = r.mtimeMs
      setConflict(null)
      setError(null)
      setContent((c) => (c ? { ...c, text, mtimeMs: r.mtimeMs } : c))
      if (draft.current === text) draft.current = null
    } else if (r.conflict) {
      setConflict(r.conflict)
    } else {
      setError(r.error ?? 'не записалось')
    }
  }

  // Вышли из правки — дописать хвост сразу, не дожидаясь таймера.
  useEffect(() => {
    if (active) return
    if (draft.current !== null && !conflict) void save()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  useEffect(() => {
    const el = viewRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) return
      if (el.scrollHeight - el.clientHeight > 1) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [state, active])

  const html = useMemo(() => (markdown && content ? renderMarkdown(content.text) : ''), [markdown, content])
  const name = node.file.split('/').pop() ?? node.file

  const takeDisk = (): void => {
    if (!conflict) return
    draft.current = null
    base.current = conflict.mtimeMs
    setContent((c) => (c ? { ...c, text: conflict.text, mtimeMs: conflict.mtimeMs } : c))
    setConflict(null)
  }

  let body: React.JSX.Element
  if (state === 'missing') body = <div className="node-textfile__empty">файла нет на диске</div>
  else if (state === 'large')
    body = <div className="node-textfile__empty">файл больше 2 МБ — открой его в системе ↗</div>
  else if (!content) body = <div className="node-textfile__empty">…</div>
  else if (active && !conflict)
    body = (
      <MarkdownEditor
        value={content.text}
        fontSize={fontSize}
        fontFamily={markdown ? fontFamily : 'var(--font-mono, ui-monospace, monospace)'}
        onChange={(text) => {
          draft.current = text
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => void save(), SAVE_MS)
        }}
      />
    )
  else if (markdown)
    body = (
      <div
        className="node-text node-textfile__body"
        ref={setView}
        style={{ fontSize, fontFamily }}
        /* markdown уже прогнан через DOMPurify в renderMarkdown */
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  else
    body = (
      <pre className="node-textfile__body node-textfile__pre" ref={setView}>
        {content.text}
      </pre>
    )

  return (
    <div className="node-textfile" data-testid="text-file">
      <div className="node-textfile__head" title={content?.path ?? node.file}>
        <span className="node-textfile__name">🗒 {name}</span>
        {fileSource(node) && <span className="node-textfile__meta">🔗 оригинал</span>}
        <button
          type="button"
          className="node-textfile__open"
          title="Открыть в системе"
          onClick={() => void window.api.files.openInSystem(node.file)}
        >
          ↗
        </button>
      </div>
      {conflict && (
        <div className="node-textfile__conflict" data-testid="text-file-conflict">
          <span>Файл поменялся на диске, пока ты правил.</span>
          <button type="button" onClick={takeDisk}>
            Взять с диска
          </button>
          <button type="button" data-testid="text-file-overwrite" onClick={() => void save(true)}>
            Перезаписать
          </button>
        </div>
      )}
      {error && <div className="node-textfile__conflict">Не записалось: {error}</div>}
      {body}
    </div>
  )
}

/** Плашка — иконка типа, имя, размер, «открыть». */
function FileChip({ node }: Props): React.JSX.Element {
  const name = node.file.split('/').pop() ?? node.file
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  const source = fileSource(node)
  const version = useFileVersion(node.file)
  const [size, setSize] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.files.stat(node.file).then((s) => alive && setSize(s?.size ?? null))
    return () => {
      alive = false
    }
  }, [node.file, version])

  return (
    <div className="node-file" title={source ? `${node.file}\nследует за ${source}` : node.file}>
      <span className="node-file__icon">{iconFor(ext)}</span>
      <span className="node-file__text">
        <span className="node-file__name">{name}</span>
        <span className="node-file__meta">
          {[ext.toUpperCase(), size !== null ? formatSize(size) : null, source ? '🔗 с оригиналом' : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <button
        type="button"
        className="node-file__open"
        title="Открыть в системе"
        onClick={() => void window.api.files.openInSystem(node.file)}
      >
        ↗
      </button>
    </div>
  )
}
