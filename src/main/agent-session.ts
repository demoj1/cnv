/** Общее для всех агентов: кавычки шелла и системный промпт про холст. */

/** Кавычки для шелла, в котором агент запустится. */
export function shellQuote(value: string, platform: string = process.platform): string {
  if (platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Что агент должен знать о себе с первой реплики: имя, роль, и где искать команду. */
export function agentSystemPrompt(name: string | undefined, role: string | undefined): string {
  const who = name ? `Ты — агент «${name}»` : 'Ты — агент'
  return [
    `${who} на бесконечном холсте приложения cnv: твой терминал — карточка на холсте.`,
    role ? `Твоя роль: ${role}.` : 'Роль тебе пока не задали.',
    'У тебя есть MCP-сервер cnv: whoami — кто ты и с кем соединён, connections — соседи по связям с их ролями,',
    'agent_send — написать другому агенту, terminal_read — прочитать его ответ, create_node — карточки, страницы, новые агенты.',
    'Если тебе пишет другой агент — сообщение подписано его именем; отвечай ему через agent_send.'
  ].join(' ')
}
