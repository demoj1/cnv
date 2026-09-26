import { useEffect, useInsertionEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'

interface Props {
  value: string
  onChange(value: string): void
}

export function MarkdownEditor({ value, onChange }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  useInsertionEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          })
        ]
      })
    })
    view.focus()
    return () => view.destroy()
    // value читаем только при входе в редактирование: дальше источник правды — сам CodeMirror
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="node-editor" ref={hostRef} />
}
