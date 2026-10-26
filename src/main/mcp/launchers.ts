/**
 * Обёртки `cnv-mcp` — stdio-мост для агентов. Пути в них должны пережить закрытие cnv:
 * AppImage монтируется во временный `/tmp/.mount_*`, и `process.execPath` после выхода
 * исчезает. Поэтому скрипт моста лежит рядом с обёрткой, электрон берётся из `$APPIMAGE`,
 * а если и его нет (cnv удалили или переложили) — из системного `node`: мост ответит
 * «cnv не запущен», а не упадёт.
 */

export interface LauncherPaths {
  /** Чем запускать мост: электрон в режиме node, переживающий выход cnv. */
  exe: string
  /**
   * Электрон запущенного cnv (у AppImage — в его точке монтирования). Пока cnv жив, мост
   * идёт им: несколько `.AppImage`, запущенных разом (агенты при старте cnv), ловят
   * ECONNABORTED на любом соединении. После выхода cnv его нет — тогда `exe`.
   */
  live?: string
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
      // Системный node — первым: Electron в режиме node, запущенный пачкой (cnv поднимает разом
      // всех агентов), иногда остаётся с битыми подключениями (ECONNABORTED) навсегда.
      `if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then`,
      `  exec node ${sh(script)} --discovery ${sh(discovery)} "$@"`,
      'fi',
      ...(paths.live && paths.live !== exe
        ? [
            `live=${sh(paths.live)}`,
            `if [ -x "$live" ]; then`,
            `  ELECTRON_RUN_AS_NODE=1 exec "$live" ${sh(script)} --discovery ${sh(discovery)} "$@"`,
            'fi'
          ]
        : []),
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
