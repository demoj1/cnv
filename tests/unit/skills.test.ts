import { describe, expect, it, vi } from 'vitest'
import { installAgentSkills, parseSkillSearch, searchAgentSkills } from '../../src/main/skills'
import { normalizeAgentSkills, sameAgentSkills, type AgentSkill } from '../../src/shared/skills'

const react: AgentSkill = {
  id: 'vercel-labs/agent-skills@vercel-react-best-practices',
  source: 'vercel-labs/agent-skills',
  name: 'vercel-react-best-practices',
  installs: 908200
}

describe('skills.sh', () => {
  it('разбирает вывод поиска, ANSI и сокращённые числа; дубли не повторяет', () => {
    const output = [
      '\x1b[32mvercel-labs/agent-skills@vercel-react-best-practices 908.2K installs\x1b[0m',
      '└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
      'open.feishu.cn@lark-event 914400 installs',
      'vercel-labs/agent-skills@vercel-react-best-practices 908.2K installs',
      'remotion-dev/skills@remotion 1.4M installs'
    ].join('\n')
    expect(parseSkillSearch(output)).toEqual([
      react,
      { id: 'open.feishu.cn@lark-event', source: 'open.feishu.cn', name: 'lark-event', installs: 914400 },
      {
        id: 'remotion-dev/skills@remotion',
        source: 'remotion-dev/skills',
        name: 'remotion',
        installs: 1400000
      }
    ])
  })

  it('поиск идёт через CLI без shell, короткий запрос не запускается', async () => {
    const run = vi.fn(async () => 'vercel-labs/agent-skills@vercel-react-best-practices 908.2K installs')
    expect(await searchAgentSkills(' react ', run)).toEqual([react])
    expect(run).toHaveBeenCalledWith(['find', 'react'], expect.any(String))
    expect(await searchAgentSkills('x', run)).toEqual([])
    expect(run).toHaveBeenCalledOnce()
  })

  it('навыки одного источника ставятся одной командой для нужного агента', async () => {
    const run = vi.fn(async () => '')
    const other: AgentSkill = {
      id: 'vercel-labs/agent-skills@web-design',
      source: react.source,
      name: 'web-design',
      installs: 10
    }
    await installAgentSkills('/work/project', 'claude-code', [react, other], run)
    expect(run).toHaveBeenCalledWith(
      [
        'add',
        react.source,
        '--skill',
        react.name,
        '--skill',
        other.name,
        '--agent',
        'claude-code',
        '--copy',
        '--yes'
      ],
      '/work/project'
    )
    await installAgentSkills('/work/project', 'codex', [], run)
    expect(run).toHaveBeenCalledOnce()
  })

  it('из канваса читает только валидные уникальные навыки; порядок не меняет равенство', () => {
    expect(normalizeAgentSkills([react, react, { name: '', source: 'x', installs: 1 }, null])).toEqual([
      react
    ])
    expect(normalizeAgentSkills([])).toBeUndefined()
    const other: AgentSkill = { id: 'x/y@z', source: 'x/y', name: 'z', installs: 0 }
    expect(sameAgentSkills([react, other], [other, react])).toBe(true)
    expect(sameAgentSkills([react], [])).toBe(false)
  })
})
