import { useEffect, useState } from 'react'
import type { AgentSkill } from '@shared/skills'

interface Props {
  initialRole: string
  initialSkills: readonly AgentSkill[]
  onSubmit(role: string, skills: AgentSkill[]): void
  onCancel(): void
}

const installs = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

/** Роль агента и его навыки: подсказки skills.sh ищутся по тексту роли. */
export function RoleDialog({ initialRole, initialSkills, onSubmit, onCancel }: Props): React.JSX.Element {
  const [role, setRole] = useState(initialRole)
  const [selected, setSelected] = useState<AgentSkill[]>([...initialSkills])
  const [results, setResults] = useState<AgentSkill[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      const query = role.trim() || 'development'
      setResults(null)
      setError('')
      void window.api.agents
        .searchSkills(query)
        .then((skills) => {
          if (alive) setResults(skills)
        })
        .catch((reason: unknown) => {
          if (!alive) return
          setResults([])
          setError(reason instanceof Error ? reason.message : String(reason))
        })
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [role])

  const toggle = (skill: AgentSkill): void =>
    setSelected((current) =>
      current.some((s) => s.id === skill.id) ? current.filter((s) => s.id !== skill.id) : [...current, skill]
    )

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog dialog--wide role-dialog" role="dialog" data-testid="text-prompt">
        <div className="dialog__title">Роль и навыки агента</div>
        <input
          autoFocus
          className="dialog__input"
          data-testid="role-input"
          value={role}
          placeholder="ревьюер, React-разработчик, пишет тесты…"
          onChange={(e) => setRole(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(role.trim(), selected)
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="role-dialog__skills-title">Навыки из skills.sh — поиск по роли</div>
        {selected.length > 0 && (
          <div className="role-dialog__selected" data-testid="selected-skills">
            {selected.map((skill) => (
              <button
                key={skill.id}
                type="button"
                data-selected-skill={skill.id}
                title={`${skill.id} — убрать`}
                onClick={() => toggle(skill)}
              >
                {skill.name} ×
              </button>
            ))}
          </div>
        )}
        <div className="role-dialog__results" data-testid="skill-results">
          {results === null && <div className="settings__hint">ищу навыки…</div>}
          {error && <div className="role-dialog__error">{error}</div>}
          {results?.length === 0 && !error && <div className="settings__hint">ничего не нашлось</div>}
          {results?.slice(0, 30).map((skill) => {
            const checked = selected.some((s) => s.id === skill.id)
            return (
              <button
                key={skill.id}
                type="button"
                className={`role-dialog__skill${checked ? ' role-dialog__skill--selected' : ''}`}
                data-skill={skill.id}
                aria-pressed={checked}
                onClick={() => toggle(skill)}
              >
                <span className="role-dialog__skill-name">
                  {checked ? '✓ ' : ''}
                  {skill.name}
                </span>
                <span className="role-dialog__skill-meta">
                  {skill.source} · {installs(skill.installs)} установок
                </span>
              </button>
            )
          })}
        </div>
        <div className="role-dialog__hint">
          Навыки — сторонние инструкции. Проверь источник: выбранное установится в рабочую папку агента.
        </div>
        <div className="dialog__buttons">
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" onClick={() => onSubmit(role.trim(), selected)}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}
