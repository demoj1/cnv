import { useEffect, useState } from 'react'
import type { AgentPluginsState } from '@shared/agent-plugin'

/**
 * Плагины агентов знает main: список один на всё окно, обновляется после «перечитать»
 * в настройках. Пока не пришёл — пустой, и подписи агентов показывают id плагина.
 */
const EMPTY: AgentPluginsState = { plugins: [], errors: [], dir: '' }
let current = EMPTY
let loading: Promise<void> | null = null
const listeners = new Set<(state: AgentPluginsState) => void>()

function publish(state: AgentPluginsState): void {
  current = state
  for (const l of listeners) l(state)
}

export function reloadAgentPlugins(): Promise<AgentPluginsState> {
  return window.api.agents.reload().then((state) => {
    publish(state)
    return state
  })
}

export function useAgentPlugins(): AgentPluginsState {
  const [state, setState] = useState(current)
  useEffect(() => {
    listeners.add(setState)
    if (!loading) loading = window.api.agents.list().then(publish)
    return () => {
      listeners.delete(setState)
    }
  }, [])
  return state
}

export const agentLabel = (state: AgentPluginsState, id: string): string =>
  state.plugins.find((p) => p.id === id)?.label ?? id
