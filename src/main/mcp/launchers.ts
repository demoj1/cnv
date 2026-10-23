/**
 * Обёртки `cnv-mcp` — stdio-мост для агентов. Пути в них должны пережить закрытие cnv:
 * AppImage монтируется во временный `/tmp/.mount_*`, и `process.execPath` после выхода
 * исчезает. Поэтому скрипт моста лежит рядом с обёрткой, электрон берётся из `$APPIMAGE`,
 * а если и его нет (cnv удалили или переложили) — из системного `node`: мост ответит
 * «cnv не запущен», а не упадёт.
 */

export interface LauncherPaths {
  /** Чем запускать мост: электрон в режиме node. */
  exe: string
  /** Скрипт моста — копия в стабильной папке. */
  script: string
  discovery: string
  platform: NodeJS.Platform
}

export interface Launcher {
  file: string
  content: string
}

/** Электрон, который переживёт выход cnv: у AppImage это сам `.AppImage`, а не его точка монтирования. */
export const stableExecPath = (env: NodeJS.ProcessEnv, execPath: string): string => env.APPIMAGE || execPath

const sh = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`

export function launcherScript(paths: LauncherPaths): Launcher {
  const { exe, script, discovery } = paths
  if (paths.platform === 'win32') {
    return {
      file: 'cnv-mcp.cmd',
      content: [
        '@echo off',
        'set ELECTRON_RUN_AS_NODE=1',
        `if exist "${exe}" ("${exe}" "${script}" --discovery "${discovery}" %*) else (node "${script}" --discovery "${discovery}" %*)`,
        ''
      ].join('\r\n')
    }
  }
  return {
    file: 'cnv-mcp',
    content: [
      '#!/bin/sh',
      `exe=${sh(exe)}`,
      `if [ -x "$exe" ]; then`,
      `  ELECTRON_RUN_AS_NODE=1 exec "$exe" ${sh(script)} --discovery ${sh(discovery)} "$@"`,
      'fi',
      `exec node ${sh(script)} --discovery ${sh(discovery)} "$@"`,
      ''
    ].join('\n')
  }
}
