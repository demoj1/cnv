/**
 * Контракт плагина агента cnv. Агент — любая программа, которая живёт в терминале и умеет
 * продолжать свой разговор по id сессии: Claude Code, Codex, OpenCode или своя.
 *
 * Плагин — объект с этим интерфейсом. Встроенные написаны на TS внутри приложения, свои
 * кладутся файлами `<папка данных cnv>/agents/*.mjs` с `export default { ... }`; рядом
 * лежит этот файл как `cnv-agent.d.ts` — для подсказок:
 *
 *     // @ts-check
 *     /** @type {import('./cnv-agent').AgentPlugin} *\/
 *     export default { id: 'my-agent', label: 'Мой агент', command: 'my-agent', ... }
 *
 * Плагин выполняется внутри cnv с правами пользователя — как любой его скрипт.
 *
 * Жизненный цикл ноды-агента:
 * 1. Есть сохранённый id сессии и `hasSession` его подтверждает → в шелл печатается `resume`.
 * 2. Иначе → `start`. После него cnv опрашивает `getSession`, пока тот не вернёт id: id
 *    сохраняется в `.canvas`, и следующий запуск продолжит этот разговор.
 * Агент без сессий не нужен: `getSession` — обязательная часть контракта.
 *
 * Файл — только типы: он же уходит пользователю как `cnv-agent.d.ts`.
 */

/** MCP-сервер холста — так агент получает доступ к холсту. */
export interface AgentMcp {
  /** Streamable HTTP, только JSON. Ходить можно лишь с токеном (Bearer). */
  url: string
  /** Переменная окружения терминала, в которой лежит токен этой ноды. */
  tokenEnv: string
  /** Переменные окружения терминала, по которым stdio-мост узнаёт, из какой он ноды. */
  forwardEnv: string[]
  /** Тот же сервер через stdio: команда, аргументы и env для запуска моста. */
  stdio: { command: string; args: string[]; env: Record<string, string> }
  /** Готовый файл `{ mcpServers: { cnv: ... } }` — формат Claude Code и многих других. */
  configFile: string
}

export interface AgentContext {
  /** id ноды на холсте. */
  nodeId: string
  /** Имя агента на холсте: «Задумчивый Аркадий». */
  name?: string
  /** Роль, если задана: «ревьюер». */
  role?: string
  /** Рабочая папка терминала. */
  cwd: string
  /** Чем запускать: из настроек cnv, а если там пусто — `command` плагина. */
  command: string
  /**
   * В `start` — свежий UUID: агент, которому id сессии можно задать заранее (Claude Code),
   * берёт его. В `resume` и `hasSession` — сохранённый id сессии.
   */
  sessionId: string
  /** Первое задание агенту — только в `start`, и только если оно есть. */
  prompt?: string
  /** Кто ты, где ты и что умеешь на холсте — передай агенту как системный промпт. */
  systemPrompt: string
  /** null — MCP-сервер в настройках выключен. */
  mcp: AgentMcp | null
  /** `process.platform`: от неё зависят кавычки шелла. */
  platform: string
  /** Кавычки для шелла терминала. */
  quote(value: string): string
  /** Своя папка плагина для временных файлов (промпт, конфиг): создана заранее. */
  dataDir: string
}

export interface AgentSessionQuery extends AgentContext {
  /** Когда cnv напечатал команду `start` (мс, `Date.now()`). Сессия не старше этого. */
  startedAt: number
  /** id сессий, уже занятых другими агентами на холсте: их не возвращать. */
  taken: ReadonlySet<string>
}

type MaybePromise<T> = T | Promise<T>

/** Сессия агента для выбора «Продолжить сессию…». */
export interface AgentSessionInfo {
  id: string
  /** Когда в сессии последний раз что-то было (мс). */
  updatedAt: number
  /** О чём разговор: заголовок или первое сообщение. */
  title?: string
}

export interface AgentPlugin {
  /** Латиница, цифры и дефис: `codex`, `my-agent`. Сохраняется в `.canvas`. */
  id: string
  /** Для людей: «Codex». */
  label: string
  /** Команда по умолчанию: `codex`. В настройках её можно заменить. */
  command: string
  /** Одна строка в настройках: что это за агент. */
  description?: string
  /** Строка для шелла: новый агент. */
  start(ctx: AgentContext): MaybePromise<string>
  /** Строка для шелла: продолжить сессию `ctx.sessionId`. */
  resume(ctx: AgentContext): MaybePromise<string>
  /**
   * id сессии, которую начал `start`, или null, пока её ещё нет — cnv спросит снова.
   * Сессию надо отличить от чужих: по `cwd`, по времени не раньше `startedAt`, мимо `taken`.
   */
  getSession(query: AgentSessionQuery): MaybePromise<string | null>
  /** Жива ли сессия `ctx.sessionId`. Нет метода — сохранённой сессии верим на слово. */
  hasSession?(ctx: AgentContext): MaybePromise<boolean>
  /**
   * Сессии агента в папке `ctx.cwd`, свежие первыми — для «Продолжить сессию…». Нет метода —
   * выбрать сессию можно только вписав id руками.
   */
  listSessions?(ctx: AgentContext): MaybePromise<AgentSessionInfo[]>
}

/** Плагин глазами настроек. */
export interface AgentPluginInfo {
  id: string
  label: string
  command: string
  description?: string
  /** builtin — встроенный, file — свой из папки плагинов (может перекрыть встроенный). */
  source: 'builtin' | 'file'
  file?: string
}

export interface AgentPluginsState {
  plugins: AgentPluginInfo[]
  /** Файлы, которые не загрузились, — с причиной. */
  errors: { file: string; error: string }[]
  /** Папка своих плагинов. */
  dir: string
}
