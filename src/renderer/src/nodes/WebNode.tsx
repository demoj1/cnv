import type { LinkNode } from '@shared/canvas'
import type { DocNode } from '@core/document'
import type { NodeViewProps } from './registry'

type Props = NodeViewProps<DocNode & LinkNode>

/** Заглушка до Фазы 4: живой <webview> появится вместе с менеджером жизненного цикла. */
export function WebNodeView({ node }: Props): React.JSX.Element {
  let host = node.url
  try {
    host = new URL(node.url).host
  } catch {
    /* оставляем как есть */
  }
  return (
    <div className="node-web-placeholder">
      <div className="node-web-placeholder__host">{host}</div>
      <button type="button" onClick={() => void window.api.shell.openExternal(node.url)}>
        Открыть в браузере
      </button>
    </div>
  )
}
