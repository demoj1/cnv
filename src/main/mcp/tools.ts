import fs from 'node:fs'
import path from 'node:path'
import { matchName, notFoundMessage } from '@core/name-match'
import { queryNodes } from '@core/node-query'
import { TIMER_DEFAULT_EVERY, formatEvery } from '@core/timer'
import type { BoardOp } from '@core/board'
import { newId } from '@core/document'
import { edgeCrossings, findOverlaps, layoutRects, type LayoutMode } from '@core/layout'
import { defaultSides } from '@core/edges'
import { htmlToText } from './html-text'
import { MessageBox, type AgentMessage } from './messages'
import type { AgentLetter } from '@shared/agent-plugin'
import type { LetterPost, LetterRoute } from './letters'
import type { PortalDelivery, PortalIncoming } from '@shared/portal'
import type { AgentNotices, TimerTick } from '@shared/api'
import type { WebCaptureOptions } from './web-capture'
import type {
  AgentEdgePatch,
  AgentMethod,
  AgentMethods,
  AgentNodeInit,
  AgentNodePatch,
  AgentBatchOp,
  AgentCanvas,
  AgentEdgeInit,
  AgentJournalEntry,
  AgentPlacement,
  AgentRect
} from '@shared/agent'
import type { CanvasColor, EdgeEnd, NodeSide } from '@shared/canvas'
import type { CommandDef } from '@shared/commands'
import { NODE_SIDES } from '@shared/canvas'
import {
  ToolInputError,
  type Caller,
  type JsonSchema,
  type McpTool,
  type ServerInfo,
  type ToolResult
} from './protocol'

/** Всё, что инструментам нужно от приложения. Электрона здесь нет — подменяется в тестах. */
export interface ToolDeps {
  call<M extends AgentMethod>(
    method: M,
    params: AgentMethods[M]['params'],
    /** Свой таймаут для долгих вызовов (письмо с файлами через портал). */
    timeoutMs?: number
  ): Promise<AgentMethods[M]['result']>
  context(): {
    appVersion: string
    canvasFile: string | null
    workspaceRoot: string | null
    mcpUrl: string
  }
  terminals: {
    list(): { nodeId: string; pid: number; shell: string; cwd: string }[]
    isRunning(nodeId: string): boolean
    write(nodeId: string, data: string): void
    /** Сколько мс терминал молчит; null — не запущен. */
    idleMs?(nodeId: string): number | null
  }
  /** Папка для вложений писем агентов. */
  attachmentsDir?: string
  /** Почта агентов — общая с доставкой писем через порталы. */
  messages?: MessageBox
  /** Почтальон: письма мимо поля ввода или вставкой, когда поле пусто. Нет — вставкой сразу. */
  post?: Pick<LetterPost, 'send'>
  /** Файл снаружи workspace копируется во вложения; путь — относительно workspace. */
  importFile(absPath: string): Promise<{ relPath: string; source?: string }>
  /** PNG нод/области в base64 — скрытым окном, без сдвига камеры человеку. */
  snapshot?(source: AgentMethods['snapshotSource']['result'], scale: number): Promise<string>
  /** Замер производительности окна холста и процессов (см. mcp/perf.ts). */
  perf?(seconds: number): Promise<unknown>
  /** PNG окна в base64; `null` — окна нет. */
  screenshot(): Promise<string | null>
  /** Гостевые страницы веб-нод по id их WebContents. */
  web: {
    evaluate(webContentsId: number, code: string): Promise<unknown>
    /** PNG страницы в base64; `null` — гостя уже нет. */
    capture(webContentsId: number, opts?: WebCaptureOptions): Promise<string | null>
    /** HTTP-запрос из общей сессии веб-страниц — с их куками и логинами. */
    fetch?(
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string }
    ): Promise<{ status: number; url: string; headers: Record<string, string>; body: Buffer }>
  }
  commands: readonly CommandDef[]
  /** Пауза для ожиданий (подменяется в тестах). */
  sleep(ms: number): Promise<void>
  /** Плагины агентов: какие бывают агенты (Claude Code, Codex…). */
  agentPlugins?(): { id: string; label: string }[]
  /** Сессии агента-плагина в папке, свежие первыми. */
  agentSessions?(
    plugin: string,
    cwd: string | undefined
  ): Promise<{ id: string; updatedAt: number; title?: string }[]>
}

/** Пауза между вставкой текста в агента и Enter. */
const PASTE_SETTLE_MS = 150
/** Файлы в письме через портал — в base64, около 8 МБ. */
const PORTAL_FILES_MAX = 11_000_000
/** Мосту к холсту на письмо через портал: очередь перед ним плюс ожидание подтверждения. */
const PORTAL_BRIDGE_MS = 60_000
/** Терминал печатал позже этого — агент занят. */
const BUSY_IDLE_MS = 1500

const formatBytes = (n: number): string =>
  n < 1024 ? `${n} Б` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`

/** Время письма для шапки: письма приходят пачками — видно, какое свежее. */
const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const messageView = (m: AgentMessage): Record<string, unknown> => ({
  id: m.id,
  from: m.from,
  fromName: m.fromName,
  to: m.to,
  text: m.text,
  ...(m.replyTo ? { replyTo: m.replyTo } : {}),
  ...(m.attachments.length > 0 ? { attachments: m.attachments } : {}),
  at: new Date(m.at).toISOString()
})

const KINDS = ['text', 'file', 'web', 'group', 'terminal', 'agent', 'portal', 'timer', 'board'] as const
const COLORS = ['1', '2', '3', '4', '5', '6'] as const
const ENDS: readonly EdgeEnd[] = ['none', 'arrow']

const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: 'string',
  description,
  ...extra
})
const num = (description: string): JsonSchema => ({ type: 'number', description })
const ids = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description })
const colorSchema = str(
  'Цвет: пресет "1".."6" (красный, оранжевый, жёлтый, зелёный, голубой, фиолетовый) или "#rrggbb"'
)

const rectSchema = (description: string): JsonSchema => ({
  type: 'object',
  description,
  properties: { x: num('Левый край'), y: num('Верхний край'), width: num('Ширина'), height: num('Высота') },
  required: ['x', 'y', 'width', 'height']
})

function rect(value: unknown, key: string): AgentRect {
  const r = value as Record<string, unknown>
  for (const k of ['x', 'y', 'width', 'height']) {
    if (typeof r[k] !== 'number') throw new ToolInputError(`${key}: нужны числа x, y, width, height`)
  }
  return r as unknown as AgentRect
}

const opt = <T>(args: Record<string, unknown>, key: string): T | undefined => args[key] as T | undefined

/** «Снять цвет»: клиенты MCP шлют это кто как — null, пустой строкой, словом. */
const NO_COLOR = new Set(['', 'null', 'none', 'no', '0', 'нет', 'без цвета'])
const isNoColor = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && NO_COLOR.has(value.trim().toLowerCase()))

function color(value: unknown): CanvasColor | undefined {
  if (value === undefined || isNoColor(value)) return undefined
  const s = String(value)
  if ((COLORS as readonly string[]).includes(s) || /^#[0-9a-f]{6}$/i.test(s)) return s
  throw new ToolInputError(`цвет «${s}»: нужен "1".."6", "#rrggbb" или null / "none" — снять`)
}

function sinceMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (value.trim() && Number.isFinite(n)) return n
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  throw new ToolInputError('since: ISO-время ("2026-10-24T12:00:00Z") или число мс')
}

function nodePatch(args: Record<string, unknown>): AgentNodePatch {
  const patch: AgentNodePatch = {}
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const value = opt<number>(args, key)
    if (value !== undefined) patch[key] = value
  }
  if (args.color !== undefined) patch.color = isNoColor(args.color) ? null : (color(args.color) ?? null)
  for (const key of ['text', 'url', 'label', 'name', 'role'] as const) {
    const value = opt<string>(args, key)
    if (value !== undefined) patch[key] = value
  }
  const session = opt<string>(args, 'session_id')
  if (session !== undefined) patch.sessionId = session.trim()
  const icon = opt<string>(args, 'icon')
  if (icon !== undefined) patch.icon = icon
  const model = opt<string>(args, 'model')
  if (model !== undefined) patch.model = model
  const collapsed = opt<boolean>(args, 'collapsed')
  if (collapsed !== undefined) patch.collapsed = collapsed
  const every = opt<number>(args, 'every')
  if (every !== undefined) patch.every = every
  const message = opt<string>(args, 'message')
  if (message !== undefined) patch.message = message
  const paused = opt<boolean>(args, 'paused')
  if (paused !== undefined) patch.paused = paused
  return patch
}

/** Аргументы инструмента board → операция над доской; `get` — `null`. */
function boardOp(args: Record<string, unknown>): BoardOp | null {
  const op = args.op as string
  const need = (key: string): string => {
    const value = args[key]
    if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`для op=${op} нужен «${key}»`)
    return value
  }
  const index = opt<number>(args, 'index')
  const at = index !== undefined ? { index } : {}
  switch (op) {
    case 'get':
      return null
    case 'rename':
      return { op, title: need('title') }
    case 'add_lane':
      return { op, title: need('title'), id: newId(), ...at }
    case 'rename_lane':
      return { op, lane: need('lane'), title: need('title') }
    case 'move_lane':
      if (index === undefined) throw new ToolInputError('для op=move_lane нужен «index»')
      return { op, lane: need('lane'), index }
    case 'delete_lane':
      return { op, lane: need('lane') }
    case 'add_card': {
      const c = color(args.color)
      return { op, lane: need('lane'), text: need('text'), id: newId(), ...at, ...(c ? { color: c } : {}) }
    }
    case 'update_card': {
      const text = opt<string>(args, 'text')
      if (text === undefined && args.color === undefined)
        throw new ToolInputError('update_card: нужен text или color')
      return {
        op,
        card: need('card'),
        ...(text !== undefined ? { text } : {}),
        ...(args.color !== undefined
          ? { color: isNoColor(args.color) ? null : (color(args.color) ?? null) }
          : {})
      }
    }
    case 'move_card':
      return { op, card: need('card'), lane: need('lane'), ...at }
    case 'delete_card':
      return { op, card: need('card') }
    default:
      throw new ToolInputError(`op «${op}» не бывает`)
  }
}

/** Клавиши для terminal_send: имя → то, что шлёт терминалу клавиатура. */
const KEYS: Record<string, string> = {
  esc: '\x1b',
  escape: '\x1b',
  enter: '\r',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D'
}

export function keySequence(key: unknown): string {
  const name = String(key).trim().toLowerCase()
  const known = KEYS[name]
  if (known) return known
  const ctrl = /^ctrl\+([a-z])$/.exec(name)
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 96)
  throw new ToolInputError(`клавиша «${String(key)}»: есть ${Object.keys(KEYS).join(', ')}, ctrl+<буква>`)
}

/** Правки текста кусками и дописывание в конец — без пересылки всей карточки. */
export function editText(text: string, edits: { old?: unknown; new?: unknown }[], append?: string): string {
  let out = text
  for (const [i, e] of edits.entries()) {
    if (typeof e.old !== 'string' || typeof e.new !== 'string' || e.old === '')
      throw new ToolInputError(`edits[${i}]: нужны строки old и new`)
    const at = out.indexOf(e.old)
    if (at < 0) throw new ToolInputError(`edits[${i}]: «${e.old.slice(0, 40)}» в тексте нет`)
    if (out.indexOf(e.old, at + 1) >= 0)
      throw new ToolInputError(
        `edits[${i}]: «${e.old.slice(0, 40)}» встречается не один раз — возьми кусок длиннее`
      )
    out = out.slice(0, at) + e.new + out.slice(at + e.old.length)
  }
  if (append) out = out === '' ? append : `${out.replace(/\n*$/, '')}\n${append}`
  return out
}

function edgePatch(args: Record<string, unknown>): AgentEdgePatch {
  const patch: AgentEdgePatch = {}
  const fromSide = side(args.from_side, 'from_side')
  const toSide = side(args.to_side, 'to_side')
  const fromEnd = end(args.from_end, 'from_end')
  const toEnd = end(args.to_end, 'to_end')
  if (fromSide) patch.fromSide = fromSide
  if (toSide) patch.toSide = toSide
  if (fromEnd) patch.fromEnd = fromEnd
  if (toEnd) patch.toEnd = toEnd
  if (args.color !== undefined) patch.color = isNoColor(args.color) ? null : (color(args.color) ?? null)
  if (args.label !== undefined) patch.label = args.label === null ? null : String(args.label)
  return patch
}

function side(value: unknown, key: string): NodeSide | undefined {
  if (value === undefined) return undefined
  if ((NODE_SIDES as readonly unknown[]).includes(value)) return value as NodeSide
  throw new ToolInputError(`${key}: одно из ${NODE_SIDES.join(', ')}`)
}

function end(value: unknown, key: string): EdgeEnd | undefined {
  if (value === undefined) return undefined
  if ((ENDS as readonly unknown[]).includes(value)) return value as EdgeEnd
  throw new ToolInputError(`${key}: одно из ${ENDS.join(', ')}`)
}

const sides = {
  from_side: str('Сторона у исходной ноды', { enum: NODE_SIDES }),
  to_side: str('Сторона у целевой ноды', { enum: NODE_SIDES }),
  from_end: str('Конец у исходной ноды', { enum: ENDS }),
  to_end: str('Конец у целевой ноды (по умолчанию стрелка)', { enum: ENDS })
}

/** Дождаться, пока PTY новой терминальной ноды поднимется. */
async function waitForTerminal(deps: ToolDeps, nodeId: string, timeoutMs = 10_000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (deps.terminals.isRunning(nodeId)) return true
    await deps.sleep(100)
  }
  return false
}

export function buildTools(deps: ToolDeps): McpTool[] {
  const messages = deps.messages ?? new MessageBox()
  /** Хелперы web_eval по агентам: id ноды → имя → код. */
  const helpers = new Map<string, Map<string, string>>()

  /** Вложения письма — файлами: JSON с данными пишем сами, переданные файлы проверяем. */
  function saveAttachments(
    id: string,
    data: unknown,
    files: string[] | undefined
  ): AgentMessage['attachments'] {
    const out: AgentMessage['attachments'] = []
    if (data !== undefined && data !== null) {
      if (!deps.attachmentsDir) throw new ToolInputError('вложения здесь недоступны')
      fs.mkdirSync(deps.attachmentsDir, { recursive: true })
      const file = path.join(deps.attachmentsDir, `${id}.json`)
      const json = JSON.stringify(data, null, 2)
      fs.writeFileSync(file, json, 'utf8')
      out.push({ path: file, kind: 'json', bytes: Buffer.byteLength(json) })
    }
    for (const f of files ?? []) {
      if (!path.isAbsolute(f)) throw new ToolInputError(`files: нужен абсолютный путь — ${f}`)
      let size: number
      try {
        size = fs.statSync(f).size
      } catch {
        throw new ToolInputError(`files: нет файла ${f}`)
      }
      out.push({ path: f, kind: 'file', bytes: size })
    }
    return out
  }

  const tools: McpTool[] = [
    {
      name: 'whoami',
      description:
        'Где ты запущен: приложение cnv (бесконечный холст), файл холста, workspace, твоя карточка-терминал на нём (id, имя, роль, координаты, папка) и с кем ты соединён связями. Зови первым делом.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, caller) {
        const ctx = deps.context()
        const own = caller.nodeId ? (await deps.call('getNodes', { ids: [caller.nodeId] }))[0] : undefined
        return {
          app: 'cnv',
          version: ctx.appVersion,
          canvasFile: ctx.canvasFile,
          workspaceRoot: ctx.workspaceRoot,
          you: caller.nodeId
            ? {
                nodeId: caller.nodeId,
                name: own?.name ?? null,
                role: own?.role ?? null,
                desktop: own?.desktop ?? null,
                node: own ?? null,
                insideCanvasTerminal: true,
                connections: await connectionsOf(caller.nodeId)
              }
            : { nodeId: null, insideCanvasTerminal: false },
          activeDesktop: (await deps.call('getCanvas', { maxText: 0 })).activeDesktop,
          terminalsRunning: deps.terminals.list().length
        }
      }
    },
    {
      name: 'get_canvas',
      description:
        'Весь холст (все рабочие столы): ноды (id, kind, стол, координаты, текст/файл/url/подпись, имя, роль, cwd терминала), связи, выделение, видимая область и стол, на который смотрит человек. desktop — только один стол. Длинный текст режется до max_text — полный через get_nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          max_text: {
            type: 'integer',
            description: 'Сколько символов текста отдавать на карточку (по умолчанию 400)'
          },
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'text',
                'image',
                'pdf',
                'web',
                'group',
                'file',
                'terminal',
                'agent',
                'portal',
                'timer',
                'board'
              ]
            },
            description: 'Только ноды этих видов'
          },
          desktop: { type: 'integer', description: 'Только этот рабочий стол (1…10)' }
        }
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', {
          maxText: Math.max(0, opt<number>(args, 'max_text') ?? 400)
        })
        const kinds = opt<string[]>(args, 'kinds')
        if (kinds?.length) canvas.nodes = canvas.nodes.filter((n) => kinds.includes(n.kind))
        const desktop = opt<number>(args, 'desktop')
        if (desktop !== undefined) {
          const ids = new Set(canvas.nodes.filter((n) => n.desktop === desktop).map((n) => n.id))
          canvas.nodes = canvas.nodes.filter((n) => ids.has(n.id))
          canvas.edges = canvas.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
        }
        return canvas
      }
    },
    {
      name: 'find_nodes',
      description:
        'Найти ноды, не вытягивая весь холст: по тексту (подстрока без регистра или /регулярка/ — ищет в тексте, имени, роли, подписи, url, пути файла), видам, цвету, столу, области (within — целиком внутри, intersects — задевает), группе (id или подпись), связи с нодой (connected_to), имени и роли. Условия складываются через И. Ответ: total — сколько всего нашлось, nodes — первые limit.',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('Подстрока или /регулярка/'),
          kinds: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'text',
                'image',
                'pdf',
                'web',
                'group',
                'file',
                'terminal',
                'agent',
                'portal',
                'timer',
                'board'
              ]
            },
            description: 'Только эти виды'
          },
          color: str('"1".."6", "#rrggbb" или "none" — без цвета'),
          desktop: { type: 'integer', description: 'Только этот стол (1…10)' },
          within: rectSchema('Нода целиком внутри этого прямоугольника'),
          intersects: rectSchema('Нода задевает этот прямоугольник'),
          group: str('Нода целиком внутри группы — id или подпись группы'),
          connected_to: str('Соединена связью с этой нодой — id или имя'),
          name: str('Имя содержит (или /регулярка/)'),
          role: str('Роль содержит (или /регулярка/)'),
          limit: { type: 'integer', description: 'Сколько нод вернуть (по умолчанию 50)' },
          max_text: { type: 'integer', description: 'Сколько символов текста на ноду (по умолчанию 200)' }
        }
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', { maxText: 1_000_000 })
        let found
        try {
          found = queryNodes(canvas.nodes, canvas.edges, {
            ...(args.text !== undefined ? { text: args.text as string } : {}),
            ...(args.kinds !== undefined ? { kinds: args.kinds as string[] } : {}),
            ...(args.color !== undefined ? { color: String(args.color) } : {}),
            ...(args.desktop !== undefined ? { desktop: args.desktop as number } : {}),
            ...(args.within !== undefined ? { within: rect(args.within, 'within') } : {}),
            ...(args.intersects !== undefined ? { intersects: rect(args.intersects, 'intersects') } : {}),
            ...(args.group !== undefined ? { group: args.group as string } : {}),
            ...(args.connected_to !== undefined ? { connectedTo: args.connected_to as string } : {}),
            ...(args.name !== undefined ? { name: args.name as string } : {}),
            ...(args.role !== undefined ? { role: args.role as string } : {})
          })
        } catch (error) {
          throw new ToolInputError(error instanceof Error ? error.message : String(error))
        }
        const limit = Math.max(1, opt<number>(args, 'limit') ?? 50)
        const maxText = Math.max(0, opt<number>(args, 'max_text') ?? 200)
        return {
          total: found.length,
          nodes: found
            .slice(0, limit)
            .map((n) =>
              n.text !== undefined && n.text.length > maxText
                ? { ...n, text: n.text.slice(0, maxText), truncated: true }
                : n
            )
        }
      }
    },
    {
      name: 'get_nodes',
      description: 'Ноды по id целиком, с полным текстом.',
      inputSchema: { type: 'object', properties: { ids: ids('id нод') }, required: ['ids'] },
      run: (args) => deps.call('getNodes', { ids: args.ids as string[] })
    },
    {
      name: 'create_node',
      description:
        'Создать ноду: text (markdown-карточка), web (живая веб-страница по url), file (картинка/PDF/любой файл; абсолютный путь вне workspace копируется во вложения и следует за оригиналом; текстовый файл — .md, .txt, .dot, .json… — показан содержимым и сам обновляется, когда файл меняется на диске: пиши в файл, карточка перерисуется), group (рамка с подписью), portal (дверь к агентам другого cnv: на обеих сторонах портал с одним ключом; ключ вернётся в ответе — передай его человеку), terminal (новый терминал; command — что в нём сразу запустить), board (канбан-доска: дорожки с markdown-карточками; по умолчанию Backlog, In progress, Done — свои в lanes; дальше — инструмент board), timer (кружок, который раз в every минут шлёт message всем агентам, соединённым с ним связью, — только когда агент свободен; соедини его с агентом create_edge), agent (терминал с ИИ-агентом: своя сессия, переживает перезапуск; agent — какой: claude, codex, opencode… см. list_agent_types; prompt — первое задание). Имя даёт cnv: агенту — человеческое («Задумчивый Даня»), терминалу — номер («Терминал 3»), странице — домен. Терминалу и странице можно задать своё через name (и переименовать — update_node name), агенту — нет: его специальность пиши в role. Без x/y нода встаёт рядом с near, а по умолчанию — рядом с твоим терминалом.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: str('Вид ноды', { enum: KINDS }),
          text: str('Текст карточки (markdown) — для kind=text'),
          url: str('http(s)-адрес — для kind=web'),
          file: str('Путь к файлу — для kind=file: относительно workspace или абсолютный'),
          label: str('Подпись группы или портала — для kind=group / portal'),
          key: str(
            'Ключ портала (kind=portal): такой же, как у портала на той стороне; без него придумается новый'
          ),
          cwd: str('Рабочая папка — для kind=terminal/agent'),
          name: str(
            'Имя терминала/веб-страницы (по умолчанию придумается). Агенту имя даёт cnv — кто он и чем занят, пиши в role'
          ),
          prompt: str('Первое задание агенту — для kind=agent'),
          model: str(
            'Модель агента — для kind=agent: дешёвая на простую работу (claude: haiku/sonnet/opus, codex: gpt-5-mini…, opencode: provider/model); по умолчанию — какая в команде запуска'
          ),
          agent: str(
            'Какой агент — id плагина (claude, codex, opencode…) для kind=agent; по умолчанию — выбранный в настройках'
          ),
          role: str('Роль терминала/агента/веб-страницы: кто это и чем занят (видна другим агентам)'),
          command: str('Команда, которую выполнить в новом терминале (Enter добавится сам)'),
          every: num('Интервал таймера в минутах (kind=timer): от 1, по умолчанию 15'),
          title: str('Название доски — для kind=board'),
          lanes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Дорожки доски по порядку — для kind=board (по умолчанию Backlog, In progress, Done)'
          },
          message: str('Что таймер шлёт агентам — для kind=timer'),
          x: num('Левый край, мировые координаты'),
          y: num('Верхний край'),
          width: num('Ширина'),
          height: num('Высота'),
          near: str('id ноды, рядом с которой поставить'),
          desktop: {
            type: 'integer',
            description:
              'Рабочий стол 1…10 (по умолчанию — твой, рядом с тобой; снаружи — тот, что на экране)'
          },
          color: colorSchema
        },
        required: ['kind']
      },
      async run(args, caller) {
        const kind = args.kind as (typeof KINDS)[number]
        const params = await createParams(args, caller)
        const node = await deps.call('createNode', params)
        // Ключ портала агентам не показываем — кроме того, кто его только что создал.
        if (kind === 'portal' && params.init.kind === 'portal') {
          const created = await deps.call('portalKey', { id: node.id })
          return { node, key: created.key }
        }
        const command = opt<string>(args, 'command')
        if (kind !== 'terminal' || !command) return node
        if (!(await waitForTerminal(deps, node.id))) {
          return { node, warning: 'терминал создан, но процесс не поднялся за 10 с — команда не отправлена' }
        }
        // Шеллу нужен миг, чтобы нарисовать промпт, иначе ввод съедят его rc-файлы.
        await deps.sleep(300)
        deps.terminals.write(node.id, `${command}\r`)
        return { node, commandSent: command }
      }
    },
    {
      name: 'update_node',
      description:
        'Поменять ноду: координаты, размер, цвет (null — снять), текст карточки (целиком — text, дописать в конец — append, поправить кусками — edits), url веб-страницы, подпись группы, интервал, текст и паузу таймера.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id ноды'),
          x: num('Левый край'),
          y: num('Верхний край'),
          width: num('Ширина'),
          height: num('Высота'),
          color: { description: `${colorSchema.description}; null или "none" — снять цвет` },
          text: str('Новый текст карточки'),
          append: str('Дописать в конец текста карточки (с новой строки)'),
          edits: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Правки текста карточки кусками: [{old, new}] — old встречается в тексте ровно один раз'
          },
          url: str('Новый адрес веб-страницы'),
          label: str('Новая подпись группы'),
          role: str('Новая роль терминала/агента/веб-страницы; пустая строка — снять'),
          name: str('Новое имя терминала/агента/веб-страницы'),
          icon: str('Значок агента — один emoji (🧪, 📱…); пустая строка — снять'),
          model: str(
            'Сменить модель агента (пустая строка — какая в команде запуска): агент перезапустится в той же сессии, разговор сохранится'
          ),
          collapsed: {
            type: 'boolean',
            description:
              'Агента: true — свернуть в кружок (значок, прогресс, имя, роль; процесс работает дальше), false — развернуть'
          },
          every: num('Таймеру: новый интервал в минутах (от 1) — отсчёт начнётся заново'),
          message: str('Таймеру: новый текст письма'),
          paused: {
            type: 'boolean',
            description: 'Таймеру: true — пауза, false — запустить (отсчёт заново)'
          },
          session_id: str(
            'Агенту: продолжать эту сессию (id — из list_agent_sessions); пустая строка — начать новую: сброс контекста, имя, роль и связи остаются'
          ),
          restart: {
            type: 'boolean',
            description:
              'С session_id или model: сразу перезапустить агента (по умолчанию да; себе — нет, иначе оборвёшь свой же разговор)'
          }
        },
        required: ['id']
      },
      async run(args, caller) {
        const id = args.id as string
        const restart = opt<boolean>(args, 'restart') ?? id !== caller.nodeId
        const patch = nodePatch(args)
        const append = opt<string>(args, 'append')
        const edits = opt<{ old?: unknown; new?: unknown }[]>(args, 'edits')
        if (append !== undefined || edits?.length) {
          if (patch.text !== undefined) throw new ToolInputError('text и append/edits вместе — что-то одно')
          const [node] = await deps.call('getNodes', { ids: [id] })
          if (!node || typeof node.text !== 'string')
            throw new ToolInputError(`${id} — не текстовая карточка`)
          patch.text = editText(node.text, edits ?? [], append)
        }
        return deps.call('updateNode', { id, patch, restart })
      }
    },
    {
      name: 'batch',
      description:
        'Много правок одним вызовом и одной записью в истории — атомарно: упала любая операция, не применяется ничего. ops — список операций, каждая — объект с полем op (create_node, update_node, create_edge, update_edge, delete) и теми же аргументами, что у одноимённого инструмента. Созданному можно дать ref и дальше в этом же пакете ссылаться на него как "$ref" — в id, near, from, to. Пример mind map: [{op:"create_node",ref:"root",kind:"text",text:"Тема"},{op:"create_node",ref:"a",kind:"text",text:"Ветка",near:"$root"},{op:"create_edge",from:"$root",to:"$a"}]. Ответ: results по порядку и refs → настоящие id.',
      inputSchema: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Операции по порядку: {op: "create_node" | "update_node" | "create_edge" | "update_edge" | "delete", ...}'
          }
        },
        required: ['ops']
      },
      async run(args, caller) {
        const raw = args.ops as Record<string, unknown>[]
        if (raw.length === 0) throw new ToolInputError('ops пуст')
        if (raw.length > 500) throw new ToolInputError('не больше 500 операций в пакете')
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const resolve = async (r: string): Promise<string> => resolveIn(canvas, r)
        const edgeIds = new Set(canvas.edges.map((e) => e.id))
        const ref = (r: unknown, key: string): Promise<string> => {
          if (typeof r !== 'string' || !r) throw new ToolInputError(`нужен ${key}`)
          return r.startsWith('$') ? Promise.resolve(r) : resolve(r)
        }
        const ops: AgentBatchOp[] = []
        for (const [i, op] of raw.entries()) {
          try {
            switch (op.op) {
              case 'create_node': {
                if (op.command !== undefined)
                  throw new ToolInputError('command в пакете не поддержан — создай терминал отдельно')
                const params = await createParams(op, caller, resolve)
                ops.push({
                  op: 'create_node',
                  ...(typeof op.ref === 'string' ? { ref: op.ref } : {}),
                  ...params
                })
                break
              }
              case 'update_node':
                ops.push({ op: 'update_node', id: await ref(op.id, 'id'), patch: nodePatch(op) })
                break
              case 'create_edge':
                ops.push({
                  op: 'create_edge',
                  ...(typeof op.ref === 'string' ? { ref: op.ref } : {}),
                  edge: await edgeInit(op, caller, resolve)
                })
                break
              case 'update_edge':
                ops.push({ op: 'update_edge', id: await ref(op.id, 'id'), patch: edgePatch(op) })
                break
              case 'delete': {
                const list = Array.isArray(op.ids) ? (op.ids as unknown[]) : []
                // Связи — по id как есть: по имени ищутся только ноды.
                const ids = await Promise.all(
                  list.map((x) => (typeof x === 'string' && edgeIds.has(x) ? x : ref(x, 'ids')))
                )
                if (caller.nodeId && ids.includes(caller.nodeId)) {
                  throw new ToolInputError('это твой собственный терминал — удалять себя нельзя')
                }
                ops.push({ op: 'delete', ids })
                break
              }
              default:
                throw new ToolInputError(
                  `op: одно из create_node, update_node, create_edge, update_edge, delete`
                )
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new ToolInputError(`операция ${i + 1}: ${message} — пакет не применён`)
          }
        }
        return deps.call('batch', { ops })
      }
    },
    {
      name: 'history',
      description:
        'Журнал правок холста: кто (человек или какой агент), что (метка, какие ноды и связи добавлены, удалены, изменены) и когда — включая отмены (undo) и повторы. Не откатывается отменой: по нему видно, куда делись ноды. Фильтры: since (ISO-время или мс), actor (часть имени), ids (только правки, задевшие эти ноды). Живёт, пока cnv запущен.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { description: 'Только после этого момента: ISO-время ("2026-10-24T12:00:00Z") или мс' },
          actor: str('Автор содержит (например «Прасковья» или «человек»)'),
          ids: ids('Только правки, задевшие эти ноды или связи'),
          limit: { type: 'integer', description: 'Сколько последних записей (по умолчанию 50)' }
        }
      },
      async run(args) {
        const entries = await journal(args.since)
        const actor = opt<string>(args, 'actor')?.toLowerCase()
        const only = opt<string[]>(args, 'ids')
        const touched = (e: AgentJournalEntry): string[] => [
          ...e.nodes.added,
          ...e.nodes.removed,
          ...e.nodes.changed,
          ...e.edges.added,
          ...e.edges.removed,
          ...e.edges.changed
        ]
        const filtered = entries
          .filter((e) => !actor || e.actor.toLowerCase().includes(actor))
          .filter((e) => !only?.length || touched(e).some((id) => only.includes(id)))
        const limit = Math.max(1, opt<number>(args, 'limit') ?? 50)
        return filtered.slice(-limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() }))
      }
    },
    {
      name: 'changed_since',
      description:
        'Что изменилось на холсте с момента since (ISO-время или мс): итоговые списки добавленных, удалённых и изменённых нод и связей и кто правил. Удобно, чтобы не перечитывать весь холст: запомни время, потом спроси разницу.',
      inputSchema: {
        type: 'object',
        properties: { since: { description: 'ISO-время или мс' } },
        required: ['since']
      },
      async run(args) {
        const entries = await journal(args.since)
        const state = { nodes: new Map<string, string>(), edges: new Map<string, string>() }
        const apply = (map: Map<string, string>, part: AgentJournalEntry['nodes']): void => {
          for (const id of part.added) map.set(id, map.get(id) === 'removed' ? 'changed' : 'added')
          for (const id of part.removed) {
            if (map.get(id) === 'added') map.delete(id)
            else map.set(id, 'removed')
          }
          for (const id of part.changed) if (!map.has(id)) map.set(id, 'changed')
        }
        for (const e of entries) {
          apply(state.nodes, e.nodes)
          apply(state.edges, e.edges)
        }
        const group = (map: Map<string, string>): Record<string, string[]> => ({
          added: [...map].filter(([, k]) => k === 'added').map(([id]) => id),
          removed: [...map].filter(([, k]) => k === 'removed').map(([id]) => id),
          changed: [...map].filter(([, k]) => k === 'changed').map(([id]) => id)
        })
        return {
          since: new Date(sinceMs(args.since)).toISOString(),
          now: new Date().toISOString(),
          nodes: group(state.nodes),
          edges: group(state.edges),
          actors: [...new Set(entries.map((e) => e.actor))]
        }
      }
    },
    {
      name: 'restore',
      description:
        'Вернуть удалённые ноды по id — как были, вместе со связями (если второй конец на месте). id удалённых видны в history. Работает, пока cnv запущен.',
      inputSchema: { type: 'object', properties: { ids: ids('id удалённых нод') }, required: ['ids'] },
      run: (args) => deps.call('restore', { ids: args.ids as string[] })
    },
    {
      name: 'layout',
      description:
        'Расставить ноды одним шагом (атомарно, одной записью в истории): grid — сеткой (columns — сколько столбцов), row — в ряд, column — столбцом, radial — кругом вокруг root, tree — деревом по связям слева направо (root — корень; нет — нода без входящих). ids — id или имена; без ids — группа group (всё внутри неё). x/y — куда поставить левый верхний угол (по умолчанию — где набор сейчас). Стороны стрелок подстроятся сами.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: ids('Ноды: id или имена'),
          group: str('Или все ноды внутри группы: id или подпись'),
          mode: str('Раскладка', { enum: ['grid', 'row', 'column', 'radial', 'tree'] }),
          gap: num('Зазор между нодами (по умолчанию 40)'),
          root: str('Корень для radial и tree: id или имя'),
          columns: { type: 'integer', description: 'Столбцов в сетке' },
          x: num('Левый край раскладки'),
          y: num('Верхний край раскладки')
        },
        required: ['mode']
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const picked = await pickNodes(canvas, args)
        if (picked.length === 0) throw new ToolInputError('нечего раскладывать: дай ids или group')
        const root =
          opt<string>(args, 'root') !== undefined ? resolveIn(canvas, args.root as string) : undefined
        const x = opt<number>(args, 'x')
        const y = opt<number>(args, 'y')
        const rects = layoutRects(
          picked.map((n) => ({ id: n.id, rect: { x: n.x, y: n.y, width: n.width, height: n.height } })),
          canvas.edges,
          {
            mode: args.mode as LayoutMode,
            gap: opt<number>(args, 'gap') ?? 40,
            ...(root ? { root } : {}),
            ...(opt<number>(args, 'columns') !== undefined ? { columns: args.columns as number } : {}),
            ...(x !== undefined && y !== undefined ? { origin: { x, y } } : {})
          }
        )
        const ops: AgentBatchOp[] = [...rects].map(([id, r]) => ({
          op: 'update_node',
          id,
          patch: { x: r.x, y: r.y }
        }))
        // Стороны стрелок — по новому расположению, иначе они смотрят туда, где ноды были.
        const rectOf = (id: string): AgentRect | undefined => {
          const moved = rects.get(id)
          if (moved) return moved
          const n = canvas.nodes.find((x) => x.id === id)
          return n ? { x: n.x, y: n.y, width: n.width, height: n.height } : undefined
        }
        for (const e of canvas.edges) {
          if (!rects.has(e.fromNode) && !rects.has(e.toNode)) continue
          const from = rectOf(e.fromNode)
          const to = rectOf(e.toNode)
          if (!from || !to) continue
          ops.push({ op: 'update_edge', id: e.id, patch: defaultSides(from, to) })
        }
        await deps.call('batch', { ops })
        return { moved: rects.size, mode: args.mode, rects: Object.fromEntries(rects) }
      }
    },
    {
      name: 'check_overlaps',
      description:
        'Проверить раскладку: какие ноды налезают друг на друга и какие стрелки проходят сквозь чужие ноды. Без ids — весь стол (desktop) или весь холст. Пустые списки — всё чисто.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: ids('Только эти ноды: id или имена'),
          group: str('Или всё внутри группы'),
          desktop: { type: 'integer', description: 'Или весь этот стол' }
        }
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const desktop = opt<number>(args, 'desktop')
        const picked =
          args.ids !== undefined || args.group !== undefined
            ? await pickNodes(canvas, args)
            : canvas.nodes.filter((n) => desktop === undefined || n.desktop === desktop)
        const ids = new Set(picked.map((n) => n.id))
        const shapes = picked.map((n) => ({
          id: n.id,
          kind: n.kind,
          rect: { x: n.x, y: n.y, width: n.width, height: n.height }
        }))
        return {
          overlaps: findOverlaps(shapes),
          edgesThroughNodes: edgeCrossings(
            shapes,
            canvas.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode))
          )
        }
      }
    },
    {
      name: 'get_edges',
      description:
        'Связи: все или только задевающие ноды ids (id или имена) — с id, концами, сторонами, подписью и цветом. В отличие от get_canvas kinds=…, связи не теряются.',
      inputSchema: { type: 'object', properties: { ids: ids('Только связи этих нод: id или имена') } },
      async run(args) {
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const list = opt<string[]>(args, 'ids')
        if (!list?.length) return canvas.edges
        const ids = new Set(list.map((r) => resolveIn(canvas, r)))
        return canvas.edges.filter((e) => ids.has(e.fromNode) || ids.has(e.toNode))
      }
    },
    {
      name: 'get_subtree',
      description:
        'Поддерево от ноды по связям: direction out — куда идут стрелки (по умолчанию), in — откуда, both — в обе стороны; depth — сколько шагов (по умолчанию без ограничения). Ответ: ноды с глубиной и связи между ними — mind map или команда агентов целиком одним вызовом.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('Корень: id или имя'),
          direction: str('Направление обхода', { enum: ['out', 'in', 'both'] }),
          depth: { type: 'integer', description: 'Сколько шагов от корня' },
          max_text: { type: 'integer', description: 'Сколько текста на ноду (по умолчанию 200)' }
        },
        required: ['id']
      },
      async run(args) {
        const maxText = Math.max(0, opt<number>(args, 'max_text') ?? 200)
        const canvas = await deps.call('getCanvas', { maxText })
        const root = resolveIn(canvas, args.id as string)
        const direction = opt<string>(args, 'direction') ?? 'out'
        const limit = opt<number>(args, 'depth') ?? Infinity
        const depth = new Map([[root, 0]])
        const queue = [root]
        while (queue.length > 0) {
          const id = queue.shift()!
          const d = depth.get(id)!
          if (d >= limit) continue
          for (const e of canvas.edges) {
            const next =
              (direction !== 'in' && e.fromNode === id ? e.toNode : null) ??
              (direction !== 'out' && e.toNode === id ? e.fromNode : null)
            if (next && !depth.has(next)) {
              depth.set(next, d + 1)
              queue.push(next)
            }
          }
        }
        return {
          root,
          nodes: canvas.nodes.filter((n) => depth.has(n.id)).map((n) => ({ ...n, depth: depth.get(n.id) })),
          edges: canvas.edges.filter((e) => depth.has(e.fromNode) && depth.has(e.toNode))
        }
      }
    },
    {
      name: 'delete',
      description:
        'Удалить ноды и/или связи по id (связи удалённых нод уходят вместе с ними). Отменяется через run_command edit.undo.',
      inputSchema: { type: 'object', properties: { ids: ids('id нод и связей') }, required: ['ids'] },
      async run(args, caller) {
        const list = args.ids as string[]
        if (caller.nodeId && list.includes(caller.nodeId)) {
          throw new ToolInputError('это твой собственный терминал — удалять себя нельзя')
        }
        return deps.call('delete', { ids: list })
      }
    },
    {
      name: 'connections',
      description:
        'С кем соединена нода (по умолчанию — ты): соседи по связям с их id, именем, ролью и видом, направление (out — стрелка от тебя, in — к тебе) и подпись связи. Так агент узнаёт свою команду: с кем работать и кому писать (agent_send, terminal_send, web_read).',
      inputSchema: { type: 'object', properties: { id: str('id или имя ноды (по умолчанию ты)') } },
      async run(args, caller) {
        const ref = opt<string>(args, 'id')
        const id = ref ? await resolveAnyId(ref) : caller.nodeId
        if (!id) throw new ToolInputError('ты подключён снаружи холста — укажи id')
        return connectionsOf(id)
      }
    },
    {
      name: 'create_edge',
      description:
        'Связь (стрелка) между двумя нодами, с подписью и цветом. from по умолчанию — ты сам: так агент «цепляется» к соседу. from/to — id или имя.',
      inputSchema: {
        type: 'object',
        properties: {
          from: str('id или имя исходной ноды (по умолчанию ты)'),
          to: str('id целевой ноды'),
          label: str('Подпись на связи'),
          color: colorSchema,
          ...sides
        },
        required: ['to']
      },
      async run(args, caller) {
        return deps.call('createEdge', await edgeInit(args, caller))
      }
    },
    {
      name: 'update_edge',
      description: 'Поменять связь: подпись и цвет (null — снять), стороны, концы.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id связи'),
          label: { description: 'Подпись; null — убрать' },
          color: { description: `${colorSchema.description}; null или "none" — снять цвет` },
          ...sides
        },
        required: ['id']
      },
      run(args) {
        return deps.call('updateEdge', { id: args.id as string, patch: edgePatch(args) })
      }
    },
    {
      name: 'select',
      description:
        'Выделить ноды/связи (пустой список — снять выделение). Нужно перед run_command, которые работают по выделению.',
      inputSchema: { type: 'object', properties: { ids: ids('id нод и связей') }, required: ['ids'] },
      run: (args) => deps.call('select', { ids: args.ids as string[] })
    },
    {
      name: 'zoom_to',
      description:
        'Двигает камеру ЧЕЛОВЕКА: вписывает ноды в его экран (пустой список — весь холст). Это сбивает ему фокус — экран уезжает из-под руки, — поэтому зови только когда человек сам просит показать. Чтобы самому посмотреть на ноды — screenshot ids=… или rect=…: снимок без сдвига камеры. Пока человек водит мышью, камера не двигается (в ответе skipped); force=true — только по его просьбе.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: ids('id нод'),
          force: {
            type: 'boolean',
            description: 'Человек сам попросил показать — двигать камеру, даже если он сейчас водит мышью'
          }
        }
      },
      run: (args) =>
        deps.call('zoomTo', {
          ids: opt<string[]>(args, 'ids') ?? [],
          force: opt<boolean>(args, 'force') === true
        })
    },
    {
      name: 'list_commands',
      description:
        'Все команды приложения из меню (выравнивание, цвет, порядок, вид, undo/redo…) — для run_command.',
      inputSchema: { type: 'object', properties: {} },
      run: async () =>
        deps.commands.map((c) => ({
          id: c.id,
          label: c.label,
          section: c.section,
          ...(c.needsSelection ? { needsSelection: true } : {}),
          ...(c.needsMultiSelection ? { needsMultiSelection: true } : {})
        }))
    },
    {
      name: 'run_command',
      description:
        'Выполнить команду приложения по id из list_commands, как будто человек нажал её хоткей. Команды с needsSelection работают по выделению — сначала select. Команды вида (view.zoom*) и столов (desktop.N) двигают камеру человека: пока он водит мышью, не выполняются (skipped), force=true — только по его просьбе.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id команды, например align.left или edit.undo'),
          force: {
            type: 'boolean',
            description: 'Человек сам попросил показать — двигать камеру, даже если он сейчас водит мышью'
          }
        },
        required: ['id']
      },
      async run(args) {
        const id = args.id as string
        if (!deps.commands.some((c) => c.id === id))
          throw new ToolInputError(`нет команды ${id} — см. list_commands`)
        return deps.call('runCommand', { id, force: opt<boolean>(args, 'force') === true })
      }
    },
    {
      name: 'list_desktops',
      description:
        'Рабочие столы 1…10 (у человека Alt+1 … Alt+0): сколько на каждом нод, какие там терминалы, агенты и веб-страницы (имена и роли) и на какой стол человек смотрит сейчас. Столы — участки одного холста: агенты на всех столах живут одновременно.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, caller) {
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const running = new Set(deps.terminals.list().map((t) => t.nodeId))
        const desktops = Array.from({ length: 10 }, (_, i) => i + 1).map((desktop) => {
          const nodes = canvas.nodes.filter((n) => n.desktop === desktop)
          const named = nodes
            .filter((n) => n.kind === 'terminal' || n.kind === 'agent' || n.kind === 'web')
            .map((n) => ({
              id: n.id,
              kind: n.kind,
              ...(n.name ? { name: n.name } : {}),
              ...(n.role ? { role: n.role } : {}),
              ...(n.kind !== 'web' ? { running: running.has(n.id) } : {}),
              ...(n.id === caller.nodeId ? { isYou: true } : {})
            }))
          return {
            desktop,
            hotkey: `Alt+${desktop % 10}`,
            active: desktop === canvas.activeDesktop,
            nodes: nodes.length,
            ...(named.length ? { members: named } : {})
          }
        })
        return { activeDesktop: canvas.activeDesktop, desktops }
      }
    },
    {
      name: 'switch_desktop',
      description:
        'Переключить ЧЕЛОВЕКУ экран на рабочий стол (1…10), как Alt+цифра — сбивает ему фокус, зови только по его просьбе. Работать с нодами другого стола можно и без этого: все инструменты видят все столы, снимок — screenshot ids=…. Пока человек водит мышью, не переключает (skipped), force=true — только по его просьбе.',
      inputSchema: {
        type: 'object',
        properties: {
          desktop: { type: 'integer', description: 'Стол 1…10' },
          force: {
            type: 'boolean',
            description: 'Человек сам попросил показать — двигать камеру, даже если он сейчас водит мышью'
          }
        },
        required: ['desktop']
      },
      run: (args) =>
        deps.call('switchDesktop', {
          desktop: args.desktop as number,
          force: opt<boolean>(args, 'force') === true
        })
    },
    {
      name: 'move_to_desktop',
      description:
        'Перенести ноды (id или имена) на другой рабочий стол, сохранив их взаимное расположение. Процессы терминалов и агентов не перезапускаются.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: ids('id или имена нод'),
          desktop: { type: 'integer', description: 'Стол 1…10' }
        },
        required: ['ids', 'desktop']
      },
      async run(args) {
        const list = await Promise.all((args.ids as string[]).map((ref) => resolveAnyId(ref)))
        return deps.call('moveToDesktop', { ids: list, desktop: args.desktop as number })
      }
    },
    {
      name: 'save',
      description:
        'Сохранить холст на диск сейчас (обычно он и так сохраняется сам через секунду после правки).',
      inputSchema: { type: 'object', properties: {} },
      run: () => deps.call('save', {})
    },
    {
      name: 'list_agent_types',
      description:
        'Какие агенты бывают (плагины cnv): id для create_node kind=agent agent=<id> — Claude Code, Codex, OpenCode и свои плагины пользователя.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => deps.agentPlugins?.() ?? [{ id: 'claude', label: 'Claude Code' }]
    },
    {
      name: 'list_terminals',
      description:
        'Терминалы и агенты на холсте: id ноды, имя, вид (terminal/agent), запущен ли процесс, pid, шелл, папка, id сессии агента и какой из них ты.',
      inputSchema: { type: 'object', properties: {} },
      async run(_args, caller) {
        const running = new Map(deps.terminals.list().map((t) => [t.nodeId, t]))
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        return canvas.nodes
          .filter((n) => n.kind === 'terminal' || n.kind === 'agent')
          .map((n) => {
            const proc = running.get(n.id)
            return {
              id: n.id,
              name: n.name ?? null,
              role: n.role ?? null,
              kind: n.kind,
              ...(n.agent ? { agent: n.agent } : {}),
              desktop: n.desktop,
              running: !!proc,
              ...(proc ? { pid: proc.pid, shell: proc.shell, cwd: proc.cwd } : { cwd: n.cwd ?? null }),
              ...(n.sessionId ? { sessionId: n.sessionId } : {}),
              isYou: n.id === caller.nodeId
            }
          })
      }
    },
    {
      name: 'terminal_read',
      description:
        'Прочитать экран другого терминала (последние lines строк, как видит человек). Так можно следить за другим агентом или командой.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя терминала/агента'),
          lines: { type: 'integer', description: 'Сколько строк (по умолчанию 60)' }
        },
        required: ['id']
      },
      async run(args) {
        const node = await deps.call('findTerminal', { ref: args.id as string })
        const lines = Math.min(Math.max(opt<number>(args, 'lines') ?? 60, 1), 5000)
        return {
          id: node.id,
          name: node.name ?? null,
          ...(await deps.call('readTerminal', { id: node.id, lines }))
        }
      }
    },
    {
      name: 'terminal_send',
      description:
        'Напечатать текст в другой терминал и/или нажать клавиши. keys — клавиши после текста: esc (прервать агента), ctrl+c, ctrl+d, enter, tab, shift+tab, backspace, up, down, left, right, ctrl+<буква>. enter=true — нажать Enter в конце (по умолчанию да, если keys не заданы). В свой терминал писать нельзя.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя терминала/агента'),
          text: str('Что напечатать'),
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Клавиши по порядку после текста: ["esc"], ["ctrl+c"], ["up", "enter"]…'
          },
          enter: {
            type: 'boolean',
            description: 'Нажать Enter в конце (по умолчанию да; с keys — нет)'
          }
        },
        required: ['id']
      },
      async run(args, caller) {
        const { id, name } = await deps.call('findTerminal', { ref: args.id as string })
        if (id === caller.nodeId)
          throw new ToolInputError('это твой собственный терминал — в себя писать нельзя')
        if (!deps.terminals.isRunning(id))
          throw new ToolInputError(`терминал ${id} не запущен — см. list_terminals`)
        const keys = opt<unknown[]>(args, 'keys')
        const text = opt<string>(args, 'text') ?? ''
        if (!text && !keys?.length) throw new ToolInputError('нужен text или keys')
        const enter = opt<boolean>(args, 'enter') ?? !keys?.length
        deps.terminals.write(id, `${text}${(keys ?? []).map(keySequence).join('')}${enter ? '\r' : ''}`)
        return { sent: true, id, name: name ?? null }
      }
    },
    {
      name: 'agent_send',
      description:
        'Написать агенту (нода kind=agent) по id или имени — как будто человек написал ему в чат и нажал Enter. У письма есть id: адресат отвечает через agent_send reply_to=<id>, а ты ждёшь ответ через wait_reply id=<id> (не надо опрашивать terminal_read). Данные — не простынёй в тексте, а во вложениях: data (любой JSON — таблица, список) и files (пути к файлам); адресат получит пути к файлам и сможет прочитать их или взять через read_message. Агенту с той стороны портала (id вида «портал/агент») — файлы не больше ~8 МБ на письмо, порядок писем сохраняется; если ответ пришёл с unconfirmed — письмо ушло, но подтверждения нет: не переотправляй, жди wait_reply. Числа в data — как в JSON на JS: целые больше 2^53 теряют точность, передавай их строкой. Ответ: id письма, как дошло (via: channel/agent — мимо поля ввода адресата, terminal — вставкой, queued — человек сейчас набирает адресату текст, письмо уйдёт само, как только поле опустеет; переотправлять не надо) и занят ли адресат прямо сейчас (печатает — письмо встанет в его очередь). Прервать агента: terminal_send keys=["esc"].',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя агента (можно часть имени: «Прасковья»)'),
          message: str('Текст сообщения'),
          reply_to: str('id письма, на которое это ответ'),
          data: { description: 'Вложение-данные: любой JSON (объект, массив) — уйдёт файлом .json' },
          files: { type: 'array', items: { type: 'string' }, description: 'Вложения-файлы: абсолютные пути' },
          sign: { type: 'boolean', description: 'Подписать сообщение отправителем (по умолчанию true)' }
        },
        required: ['id', 'message']
      },
      async run(args, caller) {
        let target
        try {
          target = await deps.call('findTerminal', { ref: args.id as string })
        } catch (localError) {
          // Здесь такого нет — может, он на той стороне портала, к которому ты подключён.
          const route = caller.nodeId
            ? await deps.call('portalRoute', { from: caller.nodeId, ref: args.id as string })
            : null
          if (!route) throw localError
          return sendViaPortal(route, args, caller)
        }
        if (target.id === caller.nodeId) throw new ToolInputError('это ты сам — себе писать незачем')
        if (target.kind !== 'agent') {
          throw new ToolInputError(
            `«${target.name ?? target.id}» — не агент, а терминал: используй terminal_send`
          )
        }
        if (!deps.terminals.isRunning(target.id)) throw new ToolInputError(`агент ${target.id} не запущен`)
        const askedReplyTo = opt<string>(args, 'reply_to')
        // Письма, о котором не знаем (совсем старое), — не повод не доставить ответ: шлём без
        // привязки и говорим об этом.
        const replyTo = askedReplyTo && messages.get(askedReplyTo) ? askedReplyTo : undefined
        const replyWarning =
          askedReplyTo && !replyTo
            ? `письма ${askedReplyTo} нет в почте — ушло без привязки (reply_to)`
            : null
        const id = messages.newId()
        const attachments = saveAttachments(id, args.data, opt<string[]>(args, 'files'))
        const fromName = caller.nodeId
          ? await deps.call('getNodes', { ids: [caller.nodeId] }).then(
              (nodes) => nodes[0]?.name ?? null,
              () => null
            )
          : null
        const message = messages.post({
          id,
          from: caller.nodeId,
          fromName,
          to: target.id,
          text: args.message as string,
          ...(replyTo ? { replyTo } : {}),
          attachments,
          at: Date.now()
        })

        let text = message.text
        if (attachments.length > 0) {
          text += `\n\nВложения (прочитай файлы или read_message id=${id}):\n${attachments
            .map((a) => `- ${a.path} (${a.kind === 'json' ? 'JSON' : 'файл'}, ${formatBytes(a.bytes)})`)
            .join('\n')}`
        }
        if (opt<boolean>(args, 'sign') ?? true) {
          const from = caller.nodeId
            ? `«${fromName ?? caller.nodeId}» (id ${caller.nodeId})`
            : 'внешнего клиента cnv'
          const answer = caller.nodeId ? `; ответить: agent_send id=${caller.nodeId} reply_to=${id}` : ''
          const re = replyTo ? `, ответ на ${replyTo}` : ''
          text = `[письмо ${id} от ${from}${re}, ${clock(Date.now())}, через cnv MCP${answer}]\n${text}`
        }
        const idle = deps.terminals.idleMs?.(target.id) ?? null
        const route = await typeLetter(deps, target.id, {
          id,
          text,
          ...(caller.nodeId ? { from: { id: caller.nodeId, ...(fromName ? { name: fromName } : {}) } } : {})
        })
        return {
          sent: true,
          messageId: id,
          to: target.id,
          name: target.name ?? null,
          delivered: route !== 'queued',
          // Как дошло: каналом / API агента — мимо поля ввода; queued — человек набирает
          // агенту текст, письмо ждёт, пока поле ввода опустеет. Переотправлять не надо.
          via: route,
          // Печатал только что — работает над чем-то: письмо ляжет в его очередь.
          recipientBusy: idle !== null && idle < BUSY_IDLE_MS,
          attachments: attachments.map((a) => a.path),
          ...(replyWarning ? { warning: replyWarning } : {})
        }
      }
    },
    {
      name: 'board',
      description:
        'Канбан-доска (kind=board): дорожки с markdown-карточками. op: get — вся доска (дорожки, карточки с id); rename (title); add_lane (title, index); rename_lane (lane, title); move_lane (lane, index); delete_lane (lane — вместе с карточками); add_card (lane, text, index, color) — вернёт cardId; update_card (card, text и/или color, null — снять цвет); move_card (card, lane — куда, index — место, по умолчанию в конец); delete_card (card). lane — id или название дорожки. Агенты, соединённые с доской связью, получают письма о каждом её событии (кроме своих правок). Всё — в истории undo.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id доски или её название'),
          op: str('Операция', {
            enum: [
              'get',
              'rename',
              'add_lane',
              'rename_lane',
              'move_lane',
              'delete_lane',
              'add_card',
              'update_card',
              'move_card',
              'delete_card'
            ]
          }),
          lane: str('Дорожка: id или название (для move_card — куда)'),
          card: str('id карточки'),
          title: str('Название доски или дорожки'),
          text: str('Текст карточки, markdown; первая строка — её заголовок'),
          color: { description: `${colorSchema.description}; null — снять` },
          index: {
            type: 'integer',
            description: 'Место в дорожке или среди дорожек, с 0; по умолчанию — в конец'
          }
        },
        required: ['id', 'op']
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', { maxText: 0 })
        const ref = args.id as string
        const node =
          canvas.nodes.find((n) => n.id === ref && n.board) ??
          canvas.nodes.find((n) => n.board?.title.trim().toLowerCase() === ref.trim().toLowerCase())
        if (!node?.board) throw new ToolInputError(`нет доски «${ref}»`)
        const op = boardOp(args)
        if (!op) return { id: node.id, board: node.board }
        const updated = await deps.call('updateNode', { id: node.id, patch: { board: op }, restart: false })
        return {
          id: node.id,
          ...(op.op === 'add_card' ? { cardId: op.id } : {}),
          ...(op.op === 'add_lane' ? { laneId: op.id } : {}),
          board: updated.board
        }
      }
    },
    {
      name: 'set_status',
      description:
        'Сказать человеку, как идёт твоя работа: прогресс 0…100 и короткая строка («тесты 3/7»). Видно в шапке твоего терминала и на кружке, когда тебя свернули. Ставь на длинных задачах; закончил — clear=true. В историю правок не попадает.',
      inputSchema: {
        type: 'object',
        properties: {
          progress: num('Прогресс 0…100; не знаешь — не передавай'),
          text: str('Что делаешь сейчас — коротко, до 120 знаков'),
          clear: { type: 'boolean', description: 'Снять статус' }
        }
      },
      async run(args, caller) {
        const me = caller.nodeId
        if (!me) throw new ToolInputError('статус — только агентам на холсте')
        const progress = opt<number>(args, 'progress')
        const text = opt<string>(args, 'text')
        const status =
          opt<boolean>(args, 'clear') === true
            ? null
            : { ...(progress !== undefined ? { progress } : {}), ...(text ? { text } : {}) }
        if (status && progress === undefined && !text)
          throw new ToolInputError('нужен progress или text (или clear)')
        const node = await deps.call('updateNode', { id: me, patch: { status }, restart: false })
        return { status: node.status ?? null }
      }
    },
    {
      name: 'remind_me',
      description:
        'Напомнить себе через minutes минут: cnv сам пришлёт тебе письмо с текстом text (каналом или в чат) — вместо sleep в фоне. Напоминание живёт, пока запущен cnv.',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: num('Через сколько минут (до 1440)'),
          text: str('О чём напомнить')
        },
        required: ['minutes', 'text']
      },
      async run(args, caller) {
        const me = caller.nodeId
        if (!me) throw new ToolInputError('напоминания — только агентам на холсте')
        const minutes = Math.min(1440, Math.max(0.1, args.minutes as number))
        const id = messages.newId()
        const at = Date.now() + minutes * 60_000
        setTimeout(() => {
          if (!deps.terminals.isRunning(me)) return
          const text = `[напоминание ${id} от cnv, ${clock(Date.now())}: ты просил напомнить через ${minutes} мин]\n${args.text as string}`
          messages.post({ id, from: null, fromName: 'cnv', to: me, text, attachments: [], at: Date.now() })
          void typeLetter(deps, me, { id, text, from: { id: 'cnv', name: 'cnv' } })
        }, minutes * 60_000).unref?.()
        return { id, at: new Date(at).toISOString() }
      }
    },
    {
      name: 'list_agent_sessions',
      description:
        'Сессии агента в его папке, свежие первыми: id, когда последний раз что-то было и о чём (заголовок или первое сообщение). Чтобы перепривязать агента к старому разговору: update_node id=<агент> session_id=<id>.',
      inputSchema: {
        type: 'object',
        properties: { id: str('id или имя агента (по умолчанию ты)') }
      },
      async run(args, caller) {
        const ref = opt<string>(args, 'id') ?? caller.nodeId
        if (!ref) throw new ToolInputError('ты снаружи холста — укажи id агента')
        const node = await deps.call('findTerminal', { ref })
        if (node.kind !== 'agent') throw new ToolInputError(`«${node.name ?? node.id}» не агент`)
        const list = (await deps.agentSessions?.(node.agent ?? 'claude', node.cwd)) ?? []
        return {
          agent: node.agent ?? 'claude',
          cwd: node.cwd ?? null,
          current: node.sessionId ?? null,
          sessions: list.map((s) => ({ ...s, updatedAt: new Date(s.updatedAt).toISOString() }))
        }
      }
    },
    {
      name: 'wait_reply',
      description:
        'Дождаться ответа на своё письмо (messageId из agent_send) — или на любое из нескольких (ids): ответ — письмо от адресата тебе с reply_to=<id> или просто следующее его письмо тебе. Уже отданный ответ второй раз не отдаётся: повторный вызов ждёт следующий. Ждёт до timeout_s (по умолчанию 60, максимум 600). Если письма приходят тебе в чат сами (каналом, <channel source="cnv">), ответ придёт и так — wait_reply тогда не нужен, просто продолжай работу. Не пришёл — timeout:true; тогда можно посмотреть экран адресата через terminal_read.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('messageId твоего письма'),
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Или несколько: ждать первого ответа на любое'
          },
          timeout_s: { type: 'integer', description: 'Сколько ждать, секунд (по умолчанию 60)' }
        }
      },
      async run(args, caller) {
        const refs = [
          ...(opt<string>(args, 'id') ? [args.id as string] : []),
          ...(opt<string[]>(args, 'ids') ?? [])
        ]
        if (refs.length === 0) throw new ToolInputError('нужен id или ids')
        const originals = refs.map((ref) => {
          const m = messages.get(ref)
          if (!m) throw new ToolInputError(`нет письма ${ref}`)
          if (m.from !== caller.nodeId) throw new ToolInputError('ждать ответ можно только на своё письмо')
          return m
        })
        const timeout = Math.min(600, Math.max(1, opt<number>(args, 'timeout_s') ?? 60))
        const reply = await messages.waitReply(originals, timeout * 1000)
        return reply ? { reply: messageView(reply) } : { timeout: true, waitedS: timeout }
      }
    },
    {
      name: 'inbox',
      description:
        'Твоя почта (новые в конце) — с id, отправителем, временем, reply_to и вложениями; почта переживает перезапуск cnv. after — только после письма с этим id; sent=true — и твои отправленные; thread=<id> — вся переписка вокруг письма (вопрос → ответы). Полезно, если письмо уже уехало из экрана.',
      inputSchema: {
        type: 'object',
        properties: {
          after: str('Только письма после этого id'),
          sent: { type: 'boolean', description: 'И отправленные тобой' },
          thread: str('Переписка вокруг этого письма'),
          limit: { type: 'integer', description: 'Сколько последних (по умолчанию 20)' }
        }
      },
      async run(args, caller) {
        if (!caller.nodeId) throw new ToolInputError('у внешнего клиента нет почты — он не нода холста')
        const me = caller.nodeId
        const threadOf = opt<string>(args, 'thread')
        const list = threadOf
          ? messages.thread(threadOf).filter((m) => m.to === me || m.from === me)
          : messages.inbox(me, opt<string>(args, 'after'), opt<boolean>(args, 'sent') === true)
        const limit = Math.max(1, opt<number>(args, 'limit') ?? 20)
        return list.slice(-limit).map(messageView)
      }
    },
    {
      name: 'read_message',
      description: 'Письмо по id целиком: текст и вложения, JSON-вложения — сразу разобранными данными.',
      inputSchema: { type: 'object', properties: { id: str('id письма') }, required: ['id'] },
      async run(args, caller) {
        const m = messages.get(args.id as string)
        if (!m) throw new ToolInputError(`нет письма ${String(args.id)}`)
        if (caller.nodeId && m.to !== caller.nodeId && m.from !== caller.nodeId) {
          throw new ToolInputError('это чужое письмо')
        }
        const data = m.attachments
          .filter((a) => a.kind === 'json')
          .map((a) => {
            try {
              return JSON.parse(fs.readFileSync(a.path, 'utf8')) as unknown
            } catch {
              return null
            }
          })
        return { ...messageView(m), ...(data.length > 0 ? { data: data.length === 1 ? data[0] : data } : {}) }
      }
    },
    {
      name: 'web_fetch',
      description:
        'HTTP-запрос из общей сессии веб-страниц cnv — с куками и логинами человека, без ноды на холсте: GET/POST/любой метод, заголовки, тело (строка или JSON — тогда Content-Type: application/json). Ответ сразу удобный: JSON — разобранным, HTML — чистым текстом (as=html — как есть), остальное — текстом. max_chars режет длинный ответ, out_file кладёт тело целиком в файл (вернётся путь и размер).',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('http(s)-адрес'),
          method: str('GET, POST, PUT, PATCH, DELETE… (по умолчанию GET)'),
          headers: { type: 'object', description: 'Заголовки запроса' },
          body: { description: 'Тело: строка или JSON' },
          as: str('Как отдать ответ', { enum: ['auto', 'json', 'text', 'html'] }),
          max_chars: { type: 'integer', description: 'Сколько символов текста отдать (по умолчанию 50000)' },
          out_file: str('Абсолютный путь: записать тело ответа целиком в файл')
        },
        required: ['url']
      },
      async run(args, caller) {
        const fetcher = deps.web.fetch
        if (!fetcher) throw new ToolInputError('web_fetch здесь недоступен')
        const url = args.url as string
        if (!/^https?:\/\//i.test(url)) throw new ToolInputError('нужен http(s)-адрес')
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries((args.headers as Record<string, unknown> | undefined) ?? {})) {
          headers[k] = String(v)
        }
        let body: string | undefined
        if (args.body !== undefined && args.body !== null) {
          if (typeof args.body === 'string') body = args.body
          else {
            body = JSON.stringify(args.body)
            if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
              headers['Content-Type'] = 'application/json'
            }
          }
        }
        const method = (opt<string>(args, 'method') ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase()
        const res = await fetcher(url, { method, headers, ...(body !== undefined ? { body } : {}) })
        // Человек видит, куда ходит агент: огонёк к открытой на холсте странице того же сайта.
        if (caller.nodeId) void deps.call('noteFetch', { url }).catch(() => undefined)
        const contentType = res.headers['content-type'] ?? ''
        const base = { status: res.status, url: res.url, contentType, bytes: res.body.length }
        const outFile = opt<string>(args, 'out_file')
        if (outFile) {
          if (!path.isAbsolute(outFile)) throw new ToolInputError('out_file: нужен абсолютный путь')
          fs.mkdirSync(path.dirname(outFile), { recursive: true })
          fs.writeFileSync(outFile, res.body)
          return { ...base, savedTo: outFile }
        }
        const as = opt<string>(args, 'as') ?? 'auto'
        const raw = res.body.toString('utf8')
        if (as === 'json' || (as === 'auto' && /json/i.test(contentType))) {
          try {
            return { ...base, json: JSON.parse(raw) as unknown }
          } catch {
            if (as === 'json') throw new ToolInputError(`ответ — не JSON (${contentType || 'без типа'})`)
          }
        }
        const text = as !== 'html' && /html/i.test(contentType) ? htmlToText(raw) : raw
        const max = Math.max(100, opt<number>(args, 'max_chars') ?? 50_000)
        return text.length > max
          ? { ...base, text: text.slice(0, max), truncated: true, totalChars: text.length }
          : { ...base, text }
      }
    },
    {
      name: 'web_helpers',
      description:
        'Твои именованные JS-хелперы для web_eval: перед каждым web_eval они кладутся в window.cnv — и переживают навигацию и перезагрузку страницы. set — {имя: "код функции", …}, например {"rows": "(sel) => [...document.querySelectorAll(sel)].map(e => e.innerText)"}; потом в web_eval: cnv.rows(".item"). remove — имена на удаление. Ответ — текущий список.',
      inputSchema: {
        type: 'object',
        properties: {
          set: { type: 'object', description: 'Имя → код функции (выражение)' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Удалить эти' }
        }
      },
      async run(args, caller) {
        const key = caller.nodeId ?? ''
        const mine = helpers.get(key) ?? new Map<string, string>()
        for (const [name, code] of Object.entries((args.set as Record<string, unknown> | undefined) ?? {})) {
          if (!/^[A-Za-z_$][\w$]*$/.test(name))
            throw new ToolInputError(`имя хелпера «${name}»: латиница, цифры, _ и $`)
          if (typeof code !== 'string' || !code.trim()) throw new ToolInputError(`у «${name}» нет кода`)
          mine.set(name, code)
        }
        for (const name of opt<string[]>(args, 'remove') ?? []) mine.delete(name)
        helpers.set(key, mine)
        return Object.fromEntries(mine)
      }
    },
    {
      name: 'web_read',
      description:
        'Прочитать веб-страницу (ноду kind=web) по id или имени: url, заголовок и видимый текст (или HTML). Страница живёт в общей сессии cnv — с теми же логинами, что у человека.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя веб-страницы'),
          format: str('text (по умолчанию) или html', { enum: ['text', 'html'] }),
          max_chars: { type: 'integer', description: 'Сколько символов отдать (по умолчанию 20000)' }
        },
        required: ['id']
      },
      async run(args) {
        const { node, guest } = await webGuest(args.id as string)
        const html = opt<string>(args, 'format') === 'html'
        const max = Math.max(1, opt<number>(args, 'max_chars') ?? 20_000)
        const page = (await deps.web.evaluate(
          guest,
          `({ url: location.href, title: document.title, body: ${html ? 'document.documentElement.outerHTML' : 'document.body ? document.body.innerText : ""'} })`
        )) as { url: string; title: string; body: string }
        return {
          id: node.id,
          name: node.name ?? null,
          url: page.url,
          title: page.title,
          [html ? 'html' : 'text']: page.body.slice(0, max),
          ...(page.body.length > max ? { truncated: true, totalChars: page.body.length } : {})
        }
      }
    },
    {
      name: 'web_eval',
      description:
        'Выполнить JavaScript на веб-странице (id или имя) и вернуть результат (JSON-сериализуемый; промис дожидается). Так можно кликать, заполнять формы, доставать данные: document.querySelector(...).click(). Код — в script или файлом script_file. Большой результат: max_chars режет его, out_file кладёт целиком в файл (JSON или текст) — вернётся путь и размер.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя веб-страницы'),
          script: str('Код; значение последнего выражения — результат'),
          script_file: str('Или абсолютный путь к .js с кодом'),
          max_chars: { type: 'integer', description: 'Резать результат (в JSON) до стольких символов' },
          out_file: str('Абсолютный путь: записать результат целиком в файл')
        },
        required: ['id']
      },
      async run(args, caller) {
        const file = opt<string>(args, 'script_file')
        let script = opt<string>(args, 'script')
        if (file) {
          if (!path.isAbsolute(file)) throw new ToolInputError('script_file: нужен абсолютный путь')
          try {
            script = fs.readFileSync(file, 'utf8')
          } catch {
            throw new ToolInputError(`script_file: нет файла ${file}`)
          }
        }
        if (!script) throw new ToolInputError('нужен script или script_file')
        const { node, guest } = await webGuest(args.id as string)
        // Хелперы агента — заново перед каждым вызовом: после навигации window.cnv пуст.
        const mine = helpers.get(caller.nodeId ?? '') ?? new Map<string, string>()
        if (mine.size > 0) {
          const defs = [...mine].map(([name, code]) => `${JSON.stringify(name)}: (${code})`).join(',\n')
          await deps.web.evaluate(
            guest,
            `window.cnv = Object.assign(window.cnv || {}, {\n${defs}\n}); undefined`
          )
        }
        const raw = await evaluateScript(guest, script)
        const result = raw === undefined ? null : raw
        const base = { id: node.id, name: node.name ?? null }
        const outFile = opt<string>(args, 'out_file')
        if (outFile) {
          if (!path.isAbsolute(outFile)) throw new ToolInputError('out_file: нужен абсолютный путь')
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          fs.mkdirSync(path.dirname(outFile), { recursive: true })
          fs.writeFileSync(outFile, text, 'utf8')
          return { ...base, savedTo: outFile, chars: text.length }
        }
        const max = opt<number>(args, 'max_chars')
        if (max !== undefined) {
          const text = typeof result === 'string' ? result : JSON.stringify(result)
          if (text.length > max)
            return { ...base, result: text.slice(0, max), truncated: true, totalChars: text.length }
        }
        return { ...base, result }
      }
    },
    {
      name: 'web_navigate',
      description: 'Открыть на веб-странице (id или имя) новый адрес. Отменяется через edit.undo.',
      inputSchema: {
        type: 'object',
        properties: { id: str('id или имя веб-страницы'), url: str('http(s)-адрес') },
        required: ['id', 'url']
      },
      async run(args) {
        const { node } = await deps.call('findWeb', { ref: args.id as string })
        return deps.call('updateNode', { id: node.id, patch: { url: args.url as string } })
      }
    },
    {
      name: 'web_screenshot',
      description:
        'Скриншот одной веб-страницы (id или имя). Снимается целиком, даже если нода за краем экрана или на другом столе, — камеру человека не трогает. width — ширина вёрстки в CSS-пикселях (390 — телефон), нода при этом не меняется; full=true — вся высота страницы, а не только видимое окно.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя веб-страницы'),
          width: num('Ширина вёрстки для снимка, 200…4000 CSS-пикселей'),
          full: { type: 'boolean', description: 'Вся страница по высоте' }
        },
        required: ['id']
      },
      async run(args): Promise<ToolResult> {
        const { node, guest } = await webGuest(args.id as string)
        const width = opt<number>(args, 'width')
        if (width !== undefined && !(width >= 200 && width <= 4000))
          throw new ToolInputError('width — от 200 до 4000')
        const full = opt<boolean>(args, 'full')
        await deps.call('webStage', { id: node.id, on: true, ...(width !== undefined ? { width } : {}) })
        const data = await deps.web
          .capture(guest, { ...(width !== undefined ? { width } : {}), ...(full ? { full } : {}) })
          .finally(() => void deps.call('webStage', { id: node.id, on: false }).catch(() => {}))
        if (!data) throw new Error('страница пропала, пока снимали')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
      }
    },
    {
      name: 'perf_profile',
      description:
        'Замер производительности живого cnv за seconds секунд (по умолчанию 5, максимум 30): время кадров окна холста (fps, p95, сколько кадров дольше 20 мс), долгие задачи, самые дорогие функции renderer по CPU-профилю, загрузка всех процессов Electron (главный, renderer, GPU, веб-страницы) и размер DOM. Попроси человека в это время делать то, что тормозит (двигать холст, зумить, печатать), — и смотри, где время.',
      inputSchema: {
        type: 'object',
        properties: { seconds: { type: 'integer', description: 'Сколько секунд мерить (1…30)' } }
      },
      async run(args) {
        if (!deps.perf) throw new ToolInputError('замер здесь недоступен')
        const seconds = Math.min(30, Math.max(1, opt<number>(args, 'seconds') ?? 5))
        return deps.perf(seconds)
      }
    },
    {
      name: 'screenshot',
      description:
        'Скриншот. Без аргументов — окно cnv, как его видит человек прямо сейчас (камеру для этого не двигай!). С ids (id или имена) или rect — снимок этих нод или области холста целиком, в своём масштабе и не сдвигая человеку камеру: хоть на другом столе, хоть за краем экрана (терминалы — их текстом, страницы — их кадром). scale — масштаб (1 — как при 100 %).',
      inputSchema: {
        type: 'object',
        properties: {
          ids: ids('Снять эти ноды (с запасом по краям)'),
          rect: rectSchema('Или эту область холста'),
          scale: num('Масштаб снимка (по умолчанию 1)')
        }
      },
      async run(args): Promise<ToolResult> {
        const list = opt<string[]>(args, 'ids')
        if (list?.length || args.rect !== undefined) {
          if (!deps.snapshot) throw new ToolInputError('снимок нод здесь недоступен')
          let source
          if (list?.length) {
            const canvas = await deps.call('getCanvas', { maxText: 0 })
            source = await deps.call('snapshotSource', { ids: list.map((r) => resolveIn(canvas, r)) })
          } else {
            source = await deps.call('snapshotSource', { rect: rect(args.rect, 'rect') })
          }
          const data = await deps.snapshot(source, opt<number>(args, 'scale') ?? 1)
          return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
        }
        const data = await deps.screenshot()
        if (!data) throw new Error('окна cnv нет')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
      }
    }
  ]

  /** Ноды по ids (id или имена) или всё внутри группы. */
  async function pickNodes(
    canvas: AgentCanvas,
    args: Record<string, unknown>
  ): Promise<AgentCanvas['nodes']> {
    const list = opt<string[]>(args, 'ids')
    if (list?.length) {
      const wanted = new Set(list.map((r) => resolveIn(canvas, r)))
      return canvas.nodes.filter((n) => wanted.has(n.id))
    }
    const group = opt<string>(args, 'group')
    if (group !== undefined) {
      try {
        return queryNodes(canvas.nodes, canvas.edges, { group })
      } catch (error) {
        throw new ToolInputError(error instanceof Error ? error.message : String(error))
      }
    }
    return []
  }

  /** Записи журнала после `since` (ISO-время или мс; нет — все). */
  async function journal(since: unknown): Promise<AgentJournalEntry[]> {
    return deps.call('history', since === undefined ? {} : { since: sinceMs(since) })
  }

  /** Аргументы create_node → запрос к холсту. По умолчанию нода встаёт рядом с тобой. */
  async function createParams(
    args: Record<string, unknown>,
    caller: Caller,
    resolve: (ref: string) => Promise<string> = resolveAnyId
  ): Promise<AgentMethods['createNode']['params']> {
    const kind = args.kind as (typeof KINDS)[number]
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new ToolInputError(`kind: одно из ${KINDS.join(', ')}`)
    }
    const init = await nodeInit(kind, args)
    const place: AgentPlacement = {}
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const value = opt<number>(args, key)
      if (value !== undefined) place[key] = value
    }
    const near = opt<string>(args, 'near') ?? caller.nodeId ?? undefined
    if (near) place.near = near.startsWith('$') ? near : await resolve(near)
    const desktop = opt<number>(args, 'desktop')
    if (desktop !== undefined) place.desktop = desktop
    return { init, place, ...(args.color !== undefined ? { color: color(args.color) } : {}) }
  }

  /** Аргументы create_edge → связь; `$ref` — нода, созданная раньше в том же пакете. */
  async function edgeInit(
    args: Record<string, unknown>,
    caller: Caller,
    resolve: (ref: string) => Promise<string> = resolveAnyId
  ): Promise<AgentEdgeInit> {
    const fromRef = opt<string>(args, 'from') ?? caller.nodeId
    if (!fromRef) throw new ToolInputError('ты подключён снаружи холста — укажи from')
    if (typeof args.to !== 'string') throw new ToolInputError('не хватает аргумента «to»')
    const ref = (r: string): Promise<string> => (r.startsWith('$') ? Promise.resolve(r) : resolve(r))
    const fromSide = side(args.from_side, 'from_side')
    const toSide = side(args.to_side, 'to_side')
    const fromEnd = end(args.from_end, 'from_end')
    const toEnd = end(args.to_end, 'to_end')
    const edgeColor = color(args.color)
    const label = opt<string>(args, 'label')
    return {
      fromNode: await ref(fromRef),
      toNode: await ref(args.to),
      ...(fromSide ? { fromSide } : {}),
      ...(toSide ? { toSide } : {}),
      ...(fromEnd ? { fromEnd } : {}),
      ...(toEnd ? { toEnd } : {}),
      ...(edgeColor ? { color: edgeColor } : {}),
      ...(label ? { label } : {})
    }
  }

  /** Письмо агенту на той стороне портала: ждём подтверждения доставки. */
  async function sendViaPortal(
    route: NonNullable<AgentMethods['portalRoute']['result']>,
    args: Record<string, unknown>,
    caller: Caller
  ): Promise<unknown> {
    const me = caller.nodeId
      ? (await deps.call('getNodes', { ids: [caller.nodeId] }).catch(() => []))[0]
      : undefined
    if (!me) throw new ToolInputError('через портал пишут агенты с холста, а не внешний клиент')
    const replyTo = opt<string>(args, 'reply_to')
    const files = (opt<string[]>(args, 'files') ?? []).map((f) => {
      if (!path.isAbsolute(f)) throw new ToolInputError(`files: нужен абсолютный путь — ${f}`)
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(f)
      } catch {
        throw new ToolInputError(`files: нет файла ${f}`)
      }
      return { name: path.basename(f), base64: bytes.toString('base64') }
    })
    const total = files.reduce((n, f) => n + f.base64.length, 0)
    if (total > PORTAL_FILES_MAX) throw new ToolInputError('через портал — не больше ~8 МБ файлов в письме')
    const id = messages.newId()
    // Холст сам ждёт подтверждения со своим таймаутом по размеру (и очередь писем перед
    // этим) — мосту даём заведомо больше, чтобы он не оборвал доставку раньше.
    const bridgeTimeout = PORTAL_BRIDGE_MS + Math.ceil((total / 1_000_000) * 10_000)
    const delivery = await deps
      .call(
        'portalSend',
        {
          portalId: route.portalId,
          message: {
            id,
            from: { id: me.id, name: me.name ?? me.id, ...(me.role ? { role: me.role } : {}) },
            to: route.member.id,
            text: args.message as string,
            ...(replyTo ? { replyTo } : {}),
            ...(args.data !== undefined && args.data !== null ? { data: args.data } : {}),
            ...(files.length > 0 ? { files } : {})
          }
        },
        bridgeTimeout
      )
      .catch((e: unknown): PortalDelivery => ({
        ok: false,
        unconfirmed: true,
        error: e instanceof Error ? e.message : String(e)
      }))
    if (!delivery.ok && !delivery.unconfirmed)
      throw new ToolInputError(`портал «${route.label}»: ${delivery.error ?? 'не доставлено'}`)
    const address = `${route.portalId}/${route.member.id}`
    // Отправленное помним с вложениями — read_message покажет, что именно ушло.
    messages.post({
      id,
      from: me.id,
      fromName: me.name ?? null,
      to: address,
      text: args.message as string,
      ...(replyTo ? { replyTo } : {}),
      attachments: saveAttachments(id, args.data, opt<string[]>(args, 'files')),
      at: Date.now()
    })
    return {
      sent: true,
      messageId: id,
      to: address,
      name: route.member.name,
      via: { portal: route.label, peer: route.peerName },
      delivered: delivery.ok,
      ...(delivery.ok
        ? { recipientBusy: delivery.busy ?? false }
        : {
            unconfirmed: true,
            warning: `${delivery.error ?? 'нет подтверждения'}. Письмо могло дойти — НЕ переотправляй (будет дубль), жди ответ через wait_reply id=${id}.`
          })
    }
  }

  /** id ноды по id или имени: агенты зовут соседей по именам. */
  async function resolveAnyId(ref: string): Promise<string> {
    return resolveIn(await deps.call('getCanvas', { maxText: 0 }), ref)
  }

  /** То же по уже полученному холсту — пакету не нужно дёргать холст на каждую ссылку. */
  function resolveIn(canvas: AgentCanvas, ref: string): string {
    const byId = canvas.nodes.find((n) => n.id === ref)
    if (byId) return byId.id
    const match = matchName(canvas.nodes, ref, (n) => n.name)
    if (match.hit) return match.hit.id
    throw new ToolInputError(notFoundMessage('ноды', ref, match, (n) => `«${n.name}» (id ${n.id})`))
  }

  /** Соседи ноды по связям — её «команда». */
  async function connectionsOf(nodeId: string): Promise<unknown[]> {
    const canvas = await deps.call('getCanvas', { maxText: 200 })
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]))
    const running = new Set(deps.terminals.list().map((t) => t.nodeId))
    const out: unknown[] = []
    for (const edge of canvas.edges) {
      const outgoing = edge.fromNode === nodeId
      if (!outgoing && edge.toNode !== nodeId) continue
      const peer = byId.get(outgoing ? edge.toNode : edge.fromNode)
      if (!peer || peer.id === nodeId) continue
      const terminal = peer.kind === 'terminal' || peer.kind === 'agent'
      // Портал: кто на той стороне — только тем, кто к нему подключён (это мы и есть).
      const portal =
        peer.kind === 'portal'
          ? (await deps.call('portalInfo', { ids: [peer.id] }).catch(() => []))[0]
          : undefined
      out.push({
        edgeId: edge.id,
        direction: outgoing ? 'out' : 'in',
        ...(edge.label ? { label: edge.label } : {}),
        peer: {
          id: peer.id,
          kind: peer.kind,
          desktop: peer.desktop,
          ...(peer.name ? { name: peer.name } : {}),
          ...(peer.role ? { role: peer.role } : {}),
          ...(terminal ? { running: running.has(peer.id) } : {}),
          ...(peer.text !== undefined ? { text: peer.text } : {}),
          ...(peer.url ? { url: peer.url } : {}),
          ...(peer.file ? { file: peer.file } : {}),
          ...(peer.label ? { label: peer.label } : {}),
          ...(portal
            ? {
                portal: {
                  status: portal.status,
                  ...(portal.peer ? { otherSide: portal.peer.name } : {}),
                  ...(portal.peer?.version ? { otherSideVersion: portal.peer.version } : {}),
                  remote: portal.remote.map((m) => ({
                    id: `${peer.id}/${m.id}`,
                    name: m.name,
                    ...(m.role ? { role: m.role } : {}),
                    kind: m.kind
                  }))
                }
              }
            : {})
        }
      })
    }
    return out
  }

  /**
   * Код агента на странице. `await` на верхнем уровне executeJavaScript не понимает и падает
   * без текста («Script failed») — тогда пробуем код как async-выражение, потом как тело
   * async-функции (значение — через return).
   */
  async function evaluateScript(guest: number, script: string): Promise<unknown> {
    try {
      return await deps.web.evaluate(guest, script)
    } catch (error) {
      if (!/\bawait\b/.test(script)) throw error
      const expression = script.trim().replace(/;\s*$/, '')
      try {
        return await deps.web.evaluate(guest, `(async () => (${expression}\n))()`)
      } catch {
        try {
          return await deps.web.evaluate(guest, `(async () => {\n${script}\n})()`)
        } catch (inner) {
          const text = inner instanceof Error ? inner.message : String(inner)
          throw new Error(
            `${text} — с await на верхнем уровне значение верни через return (код выполнен как тело async-функции)`
          )
        }
      }
    }
  }

  /** Живой гость веб-ноды или понятная ошибка, почему его нет. */
  async function webGuest(ref: string): Promise<{ node: { id: string; name?: string }; guest: number }> {
    const { node, webContentsId } = await deps.call('findWeb', { ref })
    if (webContentsId === null) {
      throw new ToolInputError(
        `страница «${node.name ?? node.id}» не поднялась за 15 с (лимит живых страниц в настройках или страница зависла) — повтори позже; камеру сам не двигай`
      )
    }
    return { node, guest: webContentsId }
  }

  async function nodeInit(
    kind: (typeof KINDS)[number],
    args: Record<string, unknown>
  ): Promise<AgentNodeInit> {
    const need = (key: string): string => {
      const value = args[key]
      if (typeof value !== 'string' || value === '')
        throw new ToolInputError(`для kind=${kind} нужен «${key}»`)
      return value
    }
    switch (kind) {
      case 'text':
        return { kind, text: opt<string>(args, 'text') ?? '' }
      case 'web': {
        const name = opt<string>(args, 'name')
        const role = opt<string>(args, 'role')
        return { kind, url: need('url'), ...(name ? { name } : {}), ...(role ? { role } : {}) }
      }
      case 'file': {
        const file = need('file')
        if (!path.isAbsolute(file)) return { kind, file }
        // Снаружи workspace — копия во вложения, которая следует за оригиналом.
        const imported = await deps.importFile(file)
        return { kind, file: imported.relPath, ...(imported.source ? { source: imported.source } : {}) }
      }
      case 'group': {
        const label = opt<string>(args, 'label')
        return label ? { kind, label } : { kind }
      }
      case 'board': {
        const title = opt<string>(args, 'title')
        const lanes = opt<unknown[]>(args, 'lanes')?.filter(
          (l): l is string => typeof l === 'string' && !!l.trim()
        )
        return { kind, ...(title ? { title } : {}), ...(lanes?.length ? { lanes } : {}) }
      }
      case 'timer':
        return { kind, every: opt<number>(args, 'every') ?? TIMER_DEFAULT_EVERY, message: need('message') }
      case 'portal': {
        const label = opt<string>(args, 'label')
        const key = opt<string>(args, 'key')
        return { kind, ...(label ? { label } : {}), ...(key ? { key } : {}) }
      }
      case 'terminal': {
        const cwd = opt<string>(args, 'cwd')
        const name = opt<string>(args, 'name')
        const role = opt<string>(args, 'role')
        return { kind, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}), ...(role ? { role } : {}) }
      }
      case 'agent': {
        // Имя агенту даёт только cnv: агенты придумывают «Android разработчик» — это роль, а не имя.
        const cwd = opt<string>(args, 'cwd')
        const prompt = opt<string>(args, 'prompt')
        const role = opt<string>(args, 'role')
        const agent = opt<string>(args, 'agent')
        const model = opt<string>(args, 'model')
        const known = deps.agentPlugins?.()
        if (agent && known && !known.some((p) => p.id === agent)) {
          throw new ToolInputError(`агента «${agent}» нет; есть: ${known.map((p) => p.id).join(', ')}`)
        }
        return {
          kind,
          ...(agent ? { agent } : {}),
          ...(cwd ? { cwd } : {}),
          ...(role ? { role } : {}),
          ...(prompt ? { prompt } : {}),
          ...(model ? { model } : {})
        }
      }
    }
  }

  return tools
}

export function serverInfo(deps: ToolDeps): ServerInfo {
  return {
    name: 'cnv',
    version: deps.context().appVersion,
    instructions(caller: Caller) {
      const ctx = deps.context()
      const where = caller.nodeId
        ? `Ты запущен в терминале, который сам является карточкой на бесконечном холсте приложения cnv. Твоя карточка — нода ${caller.nodeId}.`
        : 'Ты подключён к приложению cnv (бесконечный холст) снаружи, не из его терминала.'
      return [
        where,
        `Файл холста: ${ctx.canvasFile ?? 'не открыт'} (формат JSON Canvas, как в Obsidian). Workspace: ${ctx.workspaceRoot ?? '—'}.`,
        'Через инструменты cnv ты видишь и меняешь холст на глазах у человека: карточки с markdown, картинки, PDF, живые веб-страницы, группы, связи-стрелки и другие терминалы.',
        'Начни с whoami; весь холст — get_canvas, а найти конкретное — find_nodes (по тексту, цвету, области, группе, связи) — так дешевле. Много правок сразу (mind map, таблица карточек) — одним batch: атомарно и одной записью в истории.',
        'Новые ноды без координат встают рядом с твоим терминалом. Все правки попадают в историю: человек может отменить их через Ctrl+Z (или ты — run_command edit.undo).',
        'У каждого терминала, агента и веб-страницы есть уникальное имя (агент — «Задумчивый Даня», терминал — «Терминал 3», страница — её домен) — к ним можно обращаться по имени или id (list_terminals, terminal_read, terminal_send, web_read, web_eval).',
        'Веб-страницы — живые браузеры в общей сессии cnv (с логинами человека): web_read, web_eval, web_navigate, web_screenshot.',
        'Холст поделён на 10 рабочих столов (у человека Alt+1 … Alt+0): у каждой ноды есть поле desktop, новые ноды по умолчанию встают на твой стол рядом с тобой. list_desktops — что где, switch_desktop — показать человеку стол, move_to_desktop — перенести ноды.',
        'Связи (стрелки) между нодами — это команда: connections покажет, с кем ты соединён, их имена и роли (роль — кто есть кто). Прицепиться к соседу — create_edge to=<имя>. Свою роль и роли соседей смотри в whoami/connections.',
        'Можно запускать соседних агентов (create_node kind=agent prompt=…), писать им письма (agent_send, данные — вложением data) и ждать ответ (wait_reply по id письма; отвечают через agent_send reply_to=<id>), перечитать почту — inbox; терминалы с командами — kind=terminal command=…, terminal_send.',
        'Письма тебе приходят сообщением в чат или каналом — <channel source="cnv" msg_id=… from_id=… from=…>текст</channel>; ответить: agent_send id=<from_id> reply_to=<msg_id>.',
        'Канбан-доски (kind=board) — дорожки с markdown-карточками; читать и править — инструмент board. Подключённые к доске связью агенты получают письма о её событиях.',
        'Таймеры (kind=timer) — кружки, которые раз в every минут шлют message агентам, соединённым с ними связью, когда агент свободен; письмо приходит с пометкой [таймер …]. Интервал, текст, паузу меняй update_node every/message/paused.',
        'Порталы (kind=portal) — двери к агентам другого cnv на другом компьютере: соединись с порталом стрелкой, и connections покажет, кто подключён к нему на той стороне (id вида «портал/агент»); agent_send им пишет через портал, ответ — wait_reply. Остальное с той стороны не видно.',
        'Камера и рабочий стол на экране — человека: zoom_to и switch_desktop сбивают ему фокус, зови их только по его просьбе. Посмотреть самому — screenshot ids=… или rect=… (снимок без сдвига камеры, хоть на другом столе).',
        'Файл холста руками не правь — меняй через инструменты, иначе правки разъедутся с открытым окном.'
      ].join('\n')
    }
  }
}

/**
 * Письмо агенту: почтальоном (канал, API агента, вставка без порчи черновика человека), а
 * без него — по-старому, вставкой в терминал.
 */
async function typeLetter(deps: ToolDeps, nodeId: string, letter: AgentLetter): Promise<LetterRoute> {
  if (deps.post) return deps.post.send(nodeId, letter)
  // Bracketed paste: переводы строк внутри не жмут Enter раньше времени.
  deps.terminals.write(nodeId, `\x1b[200~${letter.text}\x1b[201~`)
  // Claude Code вставку переваривает не мгновенно — Enter отдельно и чуть позже.
  await deps.sleep(PASTE_SETTLE_MS)
  deps.terminals.write(nodeId, '\r')
  return 'terminal'
}

/**
 * Имя файла с той стороны — как есть, кроме того, что опасно: пути (`/`, `\\`, `..`) и
 * управляющие символы. Скобки, пробелы, юникод — остаются.
 */
export function portalFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '_').trim()
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean.slice(0, 200)
}

/** Агентам — что поменялось в их связях и цветах: письмом от cnv, с шапкой, кто правил. */
export function notifyAgents(deps: ToolDeps, messages: MessageBox, batch: AgentNotices): void {
  const by = batch.by.length ? batch.by.join(', ') : 'человек'
  for (const { nodeId, text: body } of batch.notices) {
    if (!deps.terminals.isRunning(nodeId)) continue
    const id = messages.newId()
    const what =
      batch.about === 'board'
        ? `событие на доске — правил ${by}; вся доска — board op=get, править — board`
        : `поменялись твои связи или цвета — правил ${by}; вся картина — connections`
    const text = `[cnv ${id}, ${clock(Date.now())}: ${what}]\n${body}`
    messages.post({ id, from: null, fromName: 'cnv', to: nodeId, text, attachments: [], at: Date.now() })
    void typeLetter(deps, nodeId, { id, text, from: { id: 'cnv', name: 'cnv' } })
  }
}

/** Тик таймера — агенту письмом от cnv; ответа не ждёт. */
export function timerLetter(deps: ToolDeps, messages: MessageBox, nodeId: string, tick: TimerTick): void {
  if (!deps.terminals.isRunning(nodeId)) return
  const id = messages.newId()
  const text = `[таймер ${tick.timerId}, ${clock(Date.now())}: каждые ${formatEvery(tick.every)}; интервал, текст, пауза — update_node id=${tick.timerId} every/message/paused]\n${tick.message}`
  messages.post({ id, from: null, fromName: 'таймер', to: nodeId, text, attachments: [], at: Date.now() })
  void typeLetter(deps, nodeId, { id, text, from: { id: tick.timerId, name: 'таймер' } })
}

/**
 * Письмо с той стороны портала — агенту здесь. Портал уже проверил, что адресат к нему
 * подключён; тут — что это живой агент. Письмо ложится в почту (ответ — reply_to), текст
 * вставляется в его терминал, данные и файлы — во вложения.
 */
export async function deliverFromPortal(
  deps: ToolDeps,
  messages: MessageBox,
  incoming: PortalIncoming
): Promise<PortalDelivery> {
  const { message, portalId, portalLabel, peerName } = incoming
  const [target] = await deps.call('getNodes', { ids: [message.to] }).catch(() => [])
  if (!target || target.kind !== 'agent') return { ok: false, error: 'адресат — не агент' }
  if (!deps.terminals.isRunning(target.id))
    return { ok: false, error: `агент «${target.name ?? target.id}» не запущен` }
  if (messages.get(message.id)) return { ok: true }

  const attachments: AgentMessage['attachments'] = []
  if (deps.attachmentsDir && (message.data !== undefined || message.files?.length)) {
    // Своя папка на письмо: имена файлов остаются как у отправителя и не сталкиваются.
    const dir = path.join(deps.attachmentsDir, 'portal', message.id.replace(/[^\w-]/g, '_'))
    fs.mkdirSync(dir, { recursive: true })
    if (message.data !== undefined) {
      const file = path.join(dir, 'data.json')
      const json = JSON.stringify(message.data, null, 2)
      fs.writeFileSync(file, json, 'utf8')
      attachments.push({ path: file, kind: 'json', bytes: Buffer.byteLength(json) })
    }
    for (const f of message.files ?? []) {
      const file = path.join(dir, portalFileName(f.name))
      const bytes = Buffer.from(f.base64, 'base64')
      fs.writeFileSync(file, bytes)
      attachments.push({ path: file, kind: 'file', bytes: bytes.length })
    }
  }

  const from = `${portalId}/${message.from.id}`
  messages.post({
    id: message.id,
    from,
    fromName: `${message.from.name} (${peerName})`,
    to: target.id,
    text: message.text,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    attachments,
    at: Date.now()
  })
  let text = message.text
  if (attachments.length > 0) {
    text += `\n\nВложения (прочитай файлы или read_message id=${message.id}):\n${attachments
      .map((a) => `- ${a.path} (${a.kind === 'json' ? 'JSON' : 'файл'}, ${formatBytes(a.bytes)})`)
      .join('\n')}`
  }
  const re = message.replyTo ? `, ответ на ${message.replyTo}` : ''
  const role = message.from.role ? `, ${message.from.role}` : ''
  text = `[письмо ${message.id} от «${message.from.name}»${role} с той стороны портала «${portalLabel}» (${peerName})${re}, ${clock(Date.now())}; ответить: agent_send id=${from} reply_to=${message.id}]\n${text}`
  const idle = deps.terminals.idleMs?.(target.id) ?? null
  await typeLetter(deps, target.id, { id: message.id, text, from: { id: from, name: message.from.name } })
  return { ok: true, busy: idle !== null && idle < BUSY_IDLE_MS }
}
