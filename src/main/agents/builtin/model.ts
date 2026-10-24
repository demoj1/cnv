/**
 * Команда запуска с выбранной моделью: модель из команды (`opencode -m …` в настройках)
 * убираем, ставим `--model <модель>` — его понимают Claude Code, Codex и OpenCode.
 */
export function withModel(command: string, model: string | undefined, quote: (v: string) => string): string {
  if (!model) return command
  const bare = command.replace(/\s+(?:-m|--model)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, '')
  return `${bare} --model ${quote(model)}`
}
