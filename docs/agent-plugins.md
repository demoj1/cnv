# Свой агент для cnv

Агент в cnv — любая программа, которая живёт в терминале и умеет продолжать разговор по
id сессии. Встроены Claude Code, Codex и OpenCode. Своего агента подключает один файл
`.mjs`: собирать ничего не надо, cnv подхватывает его при старте или по кнопке
«Перечитать».

## За 5 минут

1. Открой **Настройки → Агенты → «Папка»**. Это `~/.config/cnv/agents/` (на Windows —
   `%APPDATA%\cnv\agents`, на macOS — `~/Library/Application Support/cnv/agents`).
2. Там уже лежат `cnv-agent.d.ts` (типы с описанием каждого поля) и `example.mjs.sample`.
   Скопируй пример в `my-agent.mjs`.
3. Поправь `id`, `label`, `command` и четыре функции (ниже — что они делают).
4. **Настройки → Агенты → «Перечитать».** Агент появится в списке, а если файл с ошибкой —
   под списком будет причина.
5. Правый клик по ✦ в панели слева — выбери своего агента или вытащи его на холст. Чтобы
   `Ctrl+Shift+A` создавал его, выбери его в «Агент по умолчанию».

Первая строка `// @ts-check` и комментарий `/** @type {import('./cnv-agent').AgentPlugin} */`
дают в VS Code и любом редакторе с TypeScript подсказки и проверку прямо в `.mjs`.

## Контракт

```js
// @ts-check
/** @type {import('./cnv-agent').AgentPlugin} */
export default {
  id: 'my-agent',          // латиница, цифры, дефис; сохраняется в .canvas
  label: 'Мой агент',      // для людей
  command: 'my-agent',     // команда по умолчанию; в настройках её можно заменить
  description: 'одна строка для настроек',

  start(ctx) { ... },      // строка для шелла: новый агент
  resume(ctx) { ... },     // строка для шелла: продолжить сессию ctx.sessionId
  getSession(query) { ... }, // ОБЯЗАТЕЛЬНО: id сессии, которую начал start, или null
  hasSession(ctx) { ... },  // необязательно: жива ли сохранённая сессия
  listSessions(ctx) { ... }, // необязательно: прошлые сессии для «Продолжить сессию…»

  // Письма от других агентов — всё необязательно, см. «Как доставлять письма»:
  mcpChannel: false,        // агент принимает MCP channels (Claude Code)
  deliver(ctx, letter) { ... }, // свой способ мимо поля ввода; true — доставлено
  inputDraft(screen) { ... }    // что набрано в поле ввода, по тексту экрана
}
```

Как cnv этим пользуется, каждый раз при запуске ноды-агента:

1. В ноде есть сохранённый id сессии, и `hasSession` (если он есть) говорит «жива» →
   в шелл печатается то, что вернул `resume`.
2. Иначе → печатается `start`. Сразу после этого cnv опрашивает `getSession`: каждые
   1,5 с первую минуту, потом каждые 4 с, пока терминал жив. Как только функция вернула
   строку, это id сессии: cnv пишет его в `.canvas`, и следующий запуск пойдёт по пункту 1.

Агент без сессий cnv не нужен — поэтому `getSession` обязателен. Функции могут быть
`async`. Если `start` или `resume` бросили ошибку, её текст печатается прямо в терминал
агента.

### Что лежит в `ctx`

| Поле | Что это |
|---|---|
| `command` | команда из настроек, а если там пусто — `command` плагина |
| `sessionId` | в `start` — свежий UUID (бери, если агент умеет принять id заранее); в `resume` и `hasSession` — сохранённый id |
| `prompt` | первое задание агенту (только в `start` и только если оно есть) |
| `model` | модель, которую выбрали агенту (координатор через `create_node model` или `update_node model`); передай её своим флагом вместо прописанной в `command` |
| `systemPrompt` | готовый текст: кто агент, его имя, роль и что он умеет на холсте — передай как системный промпт |
| `name`, `role` | имя агента на холсте и роль |
| `cwd` | рабочая папка терминала |
| `mcp` | как подключить холст: `url` (HTTP), `tokenEnv` (переменная с токеном), `stdio` (команда моста), `configFile` (готовый `{ mcpServers: { cnv } }`), `serverName` (имя сервера в нём), `channels` (включены ли письма каналом); `null` — MCP выключен |
| `quote(s)` | кавычки шелла терминала — оборачивай ими всё, что пришло снаружи |
| `dataDir` | своя папка плагина для временных файлов (промпт, конфиг) |
| `platform` | `linux`, `darwin` или `win32` |

В `getSession` приходит то же самое плюс `startedAt` (когда напечатан `start`, мс) и
`taken` (id сессий, уже занятых другими агентами на холсте — их не возвращай).

### Как подключить холст

Агенту нужен MCP-сервер cnv, иначе он не увидит холст. Вариантов три — бери тот, что
умеет твой агент:

- **Файл конфига** в формате `{ mcpServers: {...} }` — `ctx.mcp.configFile`
  (так делает Claude Code: `--mcp-config <файл>`).
- **HTTP с токеном**: адрес `ctx.mcp.url`, заголовок `Authorization: Bearer <токен>`, а
  токен агент читает из переменной окружения `ctx.mcp.tokenEnv` — она уже есть в
  терминале. Так делают Codex и OpenCode, и токен не светится в командной строке.
- **stdio-мост**: `ctx.mcp.stdio.command` + `args` + `env`. Мосту нужны переменные из
  `ctx.mcp.forwardEnv` — если агент чистит окружение своих MCP-серверов, пробрось их.

### Как найти сессию в `getSession`

Три типичных случая:

1. **Агент принимает id заранее** (как `claude --session-id`): отдай ему `ctx.sessionId` в
   `start`, а в `getSession` просто верни `query.sessionId`.
2. **Агент сам выбирает id и пишет файл сессии** (как Codex): найди файлы новее
   `query.startedAt`, у которых рабочая папка — `query.cwd`, и id нет в `query.taken`;
   верни самый ранний.
3. **Агент хранит сессии в базе или отдаёт их командой** (как OpenCode): спроси базу
   (`node:sqlite` доступен) или выполни его команду списка сессий и отфильтруй так же.

Сессии ещё нет (агент заводит её с первым сообщением) — верни `null`, cnv спросит позже.

### Как доставлять письма

Агенты пишут друг другу (`agent_send`), письма приходят и с той стороны портала. Письмо не
должно врезаться в то, что человек сейчас набирает агенту, поэтому cnv пробует по порядку:

1. **Канал** — если у плагина `mcpChannel: true` и в настройках включено «Письма Claude —
   каналом» (`ctx.mcp.channels`). cnv шлёт письмо уведомлением
   `notifications/claude/channel` в MCP-соединение агента, мимо поля ввода. Плагин в
   `start`/`resume` должен включить канал сервера `ctx.mcp.serverName` (у Claude Code —
   `--dangerously-load-development-channels server:cnv`).
2. **`deliver(ctx, letter)`** — свой способ плагина: HTTP API агента и т. п. Вернул `true` —
   доставлено; `false` или ошибка — cnv идёт дальше. `letter.text` — письмо целиком, с
   шапкой «от кого и как ответить». Так сделан OpenCode: он запускается с `--port`, и
   письмо уходит в `POST /session/<id>/prompt_async`.
3. **Вставка в терминал** — только когда поле ввода пусто. Если плагин умеет
   `inputDraft(screen)`, cnv смотрит на экран (тусклые подсказки уже заменены пробелами):
   верни набранный текст, `''` — пусто, `null` — экран не тот. Без него cnv судит по
   нажатиям. Пока там черновик, письма ждут в очереди и уходят по порядку.

## Пример: Claude Code на другой модели

Отдельный агент на холсте рядом с обычным Claude — например, дешёвый на Haiku:

```js
// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

/** @param {import('./cnv-agent').AgentContext} ctx */
const base = (ctx) => [
  ctx.command,
  '--model', 'haiku',
  ...(ctx.mcp ? ['--mcp-config', ctx.quote(ctx.mcp.configFile)] : []),
  '--append-system-prompt', ctx.quote(ctx.systemPrompt)
]

/** @type {import('./cnv-agent').AgentPlugin} */
export default {
  id: 'claude-haiku',
  label: 'Claude Haiku',
  command: 'claude',
  description: 'Claude Code на Haiku — для мелких поручений',
  start: (ctx) =>
    [...base(ctx), '--session-id', ctx.sessionId, ...(ctx.prompt ? [ctx.quote(ctx.prompt)] : [])].join(' '),
  resume: (ctx) => [...base(ctx), '--resume', ctx.sessionId].join(' '),
  // id задали сами — он и есть сессия.
  getSession: (q) => q.sessionId,
  // Claude пишет сессию в ~/.claude/projects/<папка>/<id>.jsonl
  hasSession: (ctx) => {
    try {
      return fs
        .readdirSync(path.join(home, 'projects'))
        .some((d) => fs.existsSync(path.join(home, 'projects', d, `${ctx.sessionId}.jsonl`)))
    } catch {
      return false
    }
  }
}
```

## Пример: агент, который сам выбирает id

Скелет для агента, который пишет сессии в `~/.my-agent/sessions/<id>.json` с полями
`cwd` и `created`:

```js
// @ts-check
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = path.join(os.homedir(), '.my-agent', 'sessions')

/** @type {import('./cnv-agent').AgentPlugin} */
export default {
  id: 'my-agent',
  label: 'Мой агент',
  command: 'my-agent',
  start: (ctx) => {
    // Системный промпт — файлом: так не мучаемся с длинной строкой в шелле.
    const prompt = path.join(ctx.dataDir, `${ctx.nodeId}.md`)
    fs.writeFileSync(prompt, ctx.systemPrompt)
    return [ctx.command, '--instructions', ctx.quote(prompt), ...(ctx.prompt ? [ctx.quote(ctx.prompt)] : [])].join(' ')
  },
  resume: (ctx) => [ctx.command, '--resume', ctx.quote(ctx.sessionId)].join(' '),
  getSession: (q) => {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return null
    }
    const mine = files
      .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
      .filter((s) => s.cwd === q.cwd && s.created >= q.startedAt - 5000 && !q.taken.has(s.id))
      .sort((a, b) => a.created - b.created)
    return mine[0]?.id ?? null
  },
  hasSession: (ctx) => fs.existsSync(path.join(dir, `${ctx.sessionId}.json`))
}
```

## Отладка

- **Агента нет в списке** — смотри ошибку под списком в настройках: там имя файла и
  причина («нет функции getSession», «id — латиница…»). Поправь и нажми «Перечитать».
- **Агент запустился не так** — строка, которую напечатал cnv, видна в его терминале
  первой. Её можно скопировать и запустить руками.
- **Сессия не сохраняется** — значит, `getSession` всё время возвращает `null`. Проверь
  фильтр по `cwd` и `startedAt`; ошибки `getSession` печатаются в лог cnv (запусти его из
  терминала).
- **Поменять команду, не трогая плагин** — поле справа от агента в настройках: туда можно
  вписать путь, обёртку или флаги (`opencode -m другая/модель`).
- **Поправить встроенного** — сделай плагин с тем же `id` (`claude`, `codex`, `opencode`):
  свой перекрывает встроенный.

Плагин выполняется внутри cnv с правами твоего пользователя — как любой твой скрипт.
Чужие плагины читай, прежде чем класть в папку.
