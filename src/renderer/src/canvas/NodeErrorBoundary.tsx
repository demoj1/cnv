import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  nodeId: string
  children: ReactNode
}

interface State {
  message: string | null
}

/** Сломавшаяся нода показывает свою ошибку и не уносит с собой весь холст (ТЗ 11.3). */
export class NodeErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`нода ${this.props.nodeId}:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <div className="node-error">
        <div className="node-error__title">Нода не отрисовалась</div>
        <div className="node-error__detail">{this.state.message}</div>
      </div>
    )
  }
}
