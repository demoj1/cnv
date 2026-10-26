/**
 * Контракт плагина агента cnv. Агент — любая программа, которая живёт в терминале и умеет
 * продолжать свой разговор по id сессии: Claude Code, Codex, OpenCode, Kimi Code или своя.
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
  /** Имя сервера холста в `configFile` (`cnv`). */
  serverName: string
  /**
   * Письма агентам — каналом (MCP channels Claude Code), если плагин это умеет
   * (`mcpChannel`): так включено в настройках «Агенты».
   */
  channels: boolean
}

/** Письмо агенту от другого агента или с той стороны портала. */
export interface AgentLetter {
  /** id письма: на него отвечают `agent_send reply_to=<id>`. */
  id: string
  /** Текст целиком, с шапкой «[письмо … от …; ответить: …]». */
  text: string
  /** От кого: id ноды (или «портал/нода») и имя. */
  from?: { id: string; name?: string }
}

export interface AgentContext {
  /** id ноды на холсте. */
  nodeId: string
  /** Имя агента на холсте: «Задумчивый Даня». */
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
  /**
   * Модель, которую выбрали агенту (`sonnet`, `gpt-5-mini`…); нет — какая в `command`.
   * Передай её своим флагом: та, что прописана в `command`, тогда не в счёт.
   */
  model?: string
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
  /**
   * Агент принимает письма cnv каналом — MCP-уведомлением `notifications/claude/channel`
   * в своё соединение с холстом, мимо поля ввода (Claude Code). Тогда `start` и `resume`
   * должны включать канал сервера `ctx.mcp.serverName`, если `ctx.mcp.channels`.
   */
  mcpChannel?: boolean
  /**
   * Доставить письмо своим способом, мимо поля ввода: HTTP API агента и т. п. `true` —
   * доставлено; `false` или ошибка — cnv вставит письмо в терминал сам.
   */
  deliver?(ctx: AgentContext, letter: AgentLetter): MaybePromise<boolean>
  /**
   * Что человек набрал в поле ввода агента, по тексту его экрана: строка (пустая — ничего),
   * `null` — не разобрать. Пока там черновик, cnv не вставляет письма в терминал — ждёт.
   */
  inputDraft?(screen: string): string | null
  /**
   * Стартовый диалог, который cnv подтверждает за человека, — только тот, что cnv сам и
   * вызвал своими флагами (у Claude Code — подтверждение канала cnv). По экрану: что
   * нажать (`'\r'`), `null` — диалога нет. Спрашивают первую минуту после запуска.
   */
  startupAnswer?(screen: string): string | null
  /**
   * Первое сообщение нового агента — для того, кто задание и системный промпт флагами не
   * берёт (Kimi Code): тогда `start` их не печатает. cnv вставит текст в поле ввода, как
   * только `inputDraft` увидит его пустым; на паузе агента (заморозка) не вставляет и срок
   * не считает. Письма ждут первое сообщение первые 10 минут после запуска, дальше идут
   * (об этом — в лог), а сообщение ждёт поле без срока. Без `inputDraft` не вставляется.
   */
  firstMessage?(ctx: AgentContext): MaybePromise<string | null>
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
