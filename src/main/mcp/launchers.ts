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

/** Подкоманды Claude Code: им холст не нужен, и флаг перед ними может сломать разбор. */
const CLAUDE_SUBCOMMANDS = [
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'config',
  'doctor',
  'gateway',
  'import',
  'install',
  'logs',
  'mcp',
  'migrate-installer',
  'plugin',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update'
]

/**
 * Обёртка `claude` в PATH терминалов cnv: ручной запуск, и `claude -r <id>` тоже, сам
 * получает `--mcp-config` холста — иначе агент, которого продолжили руками, остаётся без
 * инструментов cnv. Настоящий `claude` ищется дальше по PATH, мимо самой обёртки. Если флаг
 * уже есть (так запускает агентов сам cnv) — ничего не добавляет. Только для sh: в Windows
 * обёртки нет.
 */
export function claudeWrapperScript(): Launcher {
  return {
    file: 'claude',
    content: [
      '#!/bin/sh',
      '# cnv: claude с холстом — добавляет --mcp-config "$CNV_MCP_CONFIG", если его нет.',
      'self=$(cd "$(dirname "$0")" && pwd)',
      'real=',
      'IFS=:',
      'for dir in $PATH; do',
      '  [ "$dir" = "$self" ] && continue',
      '  if [ -x "$dir/claude" ] && [ ! -d "$dir/claude" ]; then real="$dir/claude"; break; fi',
      'done',
      'unset IFS',
      'if [ -z "$real" ]; then echo "cnv: claude не найден в PATH" >&2; exit 127; fi',
      'case " $* " in *" --mcp-config"*) exec "$real" "$@" ;; esac',
      `case "\${1:-}" in ${CLAUDE_SUBCOMMANDS.join('|')}) exec "$real" "$@" ;; esac`,
      'if [ -n "${CNV_MCP_CONFIG:-}" ] && [ -f "$CNV_MCP_CONFIG" ]; then',
      '  exec "$real" --mcp-config "$CNV_MCP_CONFIG" "$@"',
      'fi',
      'exec "$real" "$@"',
      ''
    ].join('\n')
  }
}
