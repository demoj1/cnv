import { execFile } from 'node:child_process'
import os from 'node:os'
import type { AgentSkill } from '@shared/skills'

export type SkillsRunner = (args: string[], cwd: string) => Promise<string>

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function runSkills(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', 'skills', ...args],
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' }
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message
          reject(new Error(`skills.sh: ${detail}`))
        } else resolve(stdout)
      }
    )
  })
}

function installCount(value: string, suffix: string): number {
  const n = Number(value.replace(/,/g, ''))
  const scale = suffix.toUpperCase() === 'M' ? 1_000_000 : suffix.toUpperCase() === 'K' ? 1000 : 1
  return Math.round(n * scale)
}

/** Текстовый вывод `skills find`: по одному `источник@slug … installs` на навык. */
export function parseSkillSearch(output: string): AgentSkill[] {
  const out: AgentSkill[] = []
  const seen = new Set<string>()
  for (const raw of output.replace(ANSI, '').split('\n')) {
    const match = /^(\S+)@(\S+)\s+([\d.,]+)([KM]?)\s+installs\s*$/i.exec(raw.trim())
    if (!match) continue
    const [, source, name, count, suffix] = match
    if (!source || !name || !count || suffix === undefined) continue
    const id = `${source}@${name}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, source, name, installs: installCount(count, suffix) })
  }
  return out
}

export async function searchAgentSkills(query: string, run: SkillsRunner = runSkills): Promise<AgentSkill[]> {
  const q = query.trim().slice(0, 120)
  if (q.length < 2) return []
  return parseSkillSearch(await run(['find', q], os.homedir()))
}

/** Установка в проект агента; --copy не требует прав на symlink в Windows. */
export async function installAgentSkills(
  cwd: string,
  agent: string,
  skills: readonly AgentSkill[],
  run: SkillsRunner = runSkills
): Promise<void> {
  const bySource = new Map<string, string[]>()
  for (const skill of skills) {
    const names = bySource.get(skill.source) ?? []
    if (!names.includes(skill.name)) names.push(skill.name)
    bySource.set(skill.source, names)
  }
  for (const [source, names] of bySource) {
    const args = ['add', source]
    for (const name of names) args.push('--skill', name)
    await run([...args, '--agent', agent, '--copy', '--yes'], cwd)
  }
}
