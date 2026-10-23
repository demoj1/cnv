import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { launcherScript, stableExecPath } from '../../src/main/mcp/launchers'

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
