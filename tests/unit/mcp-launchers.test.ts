import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeWrapperScript, launcherScript, stableExecPath } from '../../src/main/mcp/launchers'

describe('обёртка cnv-mcp', () => {
  it('у AppImage берёт сам .AppImage, а не временную точку монтирования', () => {
    expect(stableExecPath({ APPIMAGE: '/home/me/cnv.AppImage' }, '/tmp/.mount_x/cnv')).toBe(
      '/home/me/cnv.AppImage'
    )
    expect(stableExecPath({}, '/opt/cnv/cnv')).toBe('/opt/cnv/cnv')
  })

  it('без электрона падает на системный node, а не в ошибку', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-launch-'))
    try {
      const script = path.join(dir, 'echo.cjs')
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      const launcher = launcherScript({ exe: '/нет/такого', script, discovery: '/d.json', platform: 'linux' })
      const file = path.join(dir, launcher.file)
      fs.writeFileSync(file, launcher.content, { mode: 0o700 })
      const out = execFileSync(file, ['x'], { encoding: 'utf8' })
      expect(JSON.parse(out)).toEqual(['--discovery', '/d.json', 'x'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('системный node — первым; нет его — электрон живого cnv, а не .AppImage; нет и его — дальше', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-launch-'))
    try {
      const script = path.join(dir, 'echo.cjs')
      fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
      // «Живой электрон» — шелл-скрипт, который помечает, что запустили именно его.
      const live = path.join(dir, 'live')
      fs.writeFileSync(live, '#!/bin/sh\nprintf live; shift; printf "%s" "$*"\n', { mode: 0o700 })
      const make = (liveExe: string, withNode = false): string => {
        const launcher = launcherScript({
          exe: '/нет/такого',
          live: liveExe,
          script,
          discovery: '/d.json',
          platform: 'linux'
        })
        const file = path.join(dir, `cnv-mcp-${path.basename(liveExe)}`)
        fs.writeFileSync(file, launcher.content, { mode: 0o700 })
        // PATH без node — проверяем запасные пути; с ним — что node выбран первым.
        const env = { PATH: withNode ? path.dirname(process.execPath) : '/нет' }
        return execFileSync(file, ['x'], { encoding: 'utf8', env })
      }
      expect(JSON.parse(make(live, true))).toEqual(['--discovery', '/d.json', 'x'])
      expect(make(live)).toBe('live--discovery /d.json x')
      expect(JSON.parse(make('/tmp/.mount_нет/cnv', true))).toEqual(['--discovery', '/d.json', 'x'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('под windows — .cmd с тем же фолбэком', () => {
    const launcher = launcherScript({
      exe: 'C:\\cnv.exe',
      script: 'C:\\m.cjs',
      discovery: 'C:\\d.json',
      platform: 'win32'
    })
    expect(launcher.file).toBe('cnv-mcp.cmd')
    expect(launcher.content).toContain('if exist "C:\\cnv.exe"')
    expect(launcher.content).toContain('else (node "C:\\m.cjs"')
  })
})

describe('обёртка claude', () => {
  const run = (args: string[], env: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnv-claude-wrap-'))
    try {
      const wrapDir = path.join(dir, 'wrap')
      const realDir = path.join(dir, 'real')
      fs.mkdirSync(wrapDir)
      fs.mkdirSync(realDir)
      fs.writeFileSync(path.join(wrapDir, 'claude'), claudeWrapperScript().content, { mode: 0o755 })
      fs.writeFileSync(path.join(realDir, 'claude'), '#!/bin/sh\necho "ARGS:$*"\n', { mode: 0o755 })
      const config = path.join(dir, 'mcp.json')
      fs.writeFileSync(config, '{}')
      return execFileSync(path.join(wrapDir, 'claude'), args, {
        env: { PATH: `${wrapDir}:${realDir}:/usr/bin:/bin`, CNV_MCP_CONFIG: config, ...env },
        encoding: 'utf8'
      })
        .trim()
        .replace(config, 'CFG')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it.skipIf(process.platform === 'win32')('ручной -r получает холст', () => {
    expect(run(['-r', 'abc'], {})).toBe('ARGS:--mcp-config CFG -r abc')
  })

  it.skipIf(process.platform === 'win32')('флаг уже есть или подкоманда — не трогает', () => {
    expect(run(['--mcp-config', '/x.json', '--resume', 'abc'], {})).toBe(
      'ARGS:--mcp-config /x.json --resume abc'
    )
    expect(run(['mcp', 'list'], {})).toBe('ARGS:mcp list')
  })

  it.skipIf(process.platform === 'win32')('вне cnv (нет CNV_MCP_CONFIG) — как обычный claude', () => {
    expect(run(['-p', 'hi'], { CNV_MCP_CONFIG: '' })).toBe('ARGS:-p hi')
  })
})
