import path from 'node:path'
import type {
  AgentEdgePatch,
  AgentMethod,
  AgentMethods,
  AgentNodeInit,
  AgentNodePatch,
  AgentPlacement
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
    params: AgentMethods[M]['params']
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
  }
  /** Файл снаружи workspace копируется во вложения; путь — относительно workspace. */
  importFile(absPath: string): Promise<string>
  /** PNG окна в base64; `null` — окна нет. */
  screenshot(): Promise<string | null>
  /** Гостевые страницы веб-нод по id их WebContents. */
  web: {
    evaluate(webContentsId: number, code: string): Promise<unknown>
    /** PNG страницы в base64; `null` — гостя уже нет. */
    capture(webContentsId: number): Promise<string | null>
  }
  commands: readonly CommandDef[]
  /** Пауза для ожиданий (подменяется в тестах). */
  sleep(ms: number): Promise<void>
}

/** Пауза между вставкой текста в агента и Enter. */
const PASTE_SETTLE_MS = 150

const KINDS = ['text', 'file', 'web', 'group', 'terminal', 'agent'] as const
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

const opt = <T>(args: Record<string, unknown>, key: string): T | undefined => args[key] as T | undefined

function color(value: unknown): CanvasColor | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const s = String(value)
  if ((COLORS as readonly string[]).includes(s) || /^#[0-9a-f]{6}$/i.test(s)) return s
  throw new ToolInputError(`цвет «${s}»: нужен "1".."6" или "#rrggbb"`)
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
              enum: ['text', 'image', 'pdf', 'web', 'group', 'file', 'terminal', 'agent']
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
      name: 'get_nodes',
      description: 'Ноды по id целиком, с полным текстом.',
      inputSchema: { type: 'object', properties: { ids: ids('id нод') }, required: ['ids'] },
      run: (args) => deps.call('getNodes', { ids: args.ids as string[] })
    },
    {
      name: 'create_node',
      description:
        'Создать ноду: text (markdown-карточка), web (живая веб-страница по url), file (картинка/PDF/любой файл; абсолютный путь вне workspace копируется во вложения), group (рамка с подписью), terminal (новый терминал; command — что в нём сразу запустить), agent (терминал с Claude Code: своя сессия, переживает перезапуск через claude -r; prompt — первое задание). Терминалы и агенты получают уникальное имя («Задумчивый Аркадий»), можно задать своё через name. Без x/y нода встаёт рядом с near, а по умолчанию — рядом с твоим терминалом.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: str('Вид ноды', { enum: KINDS }),
          text: str('Текст карточки (markdown) — для kind=text'),
          url: str('http(s)-адрес — для kind=web'),
          file: str('Путь к файлу — для kind=file: относительно workspace или абсолютный'),
          label: str('Подпись группы — для kind=group'),
          cwd: str('Рабочая папка — для kind=terminal/agent'),
          name: str('Имя терминала/агента/веб-страницы (по умолчанию придумается)'),
          prompt: str('Первое задание агенту — для kind=agent'),
          role: str('Роль терминала/агента/веб-страницы: кто это и чем занят (видна другим агентам)'),
          command: str('Команда, которую выполнить в новом терминале (Enter добавится сам)'),
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
        const init = await nodeInit(kind, args)
        const place: AgentPlacement = {}
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          const value = opt<number>(args, key)
          if (value !== undefined) place[key] = value
        }
        const near = opt<string>(args, 'near') ?? caller.nodeId ?? undefined
        if (near) place.near = near
        const desktop = opt<number>(args, 'desktop')
        if (desktop !== undefined) place.desktop = desktop
        const node = await deps.call('createNode', {
          init,
          place,
          ...(args.color !== undefined ? { color: color(args.color) } : {})
        })
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
        'Поменять ноду: координаты, размер, цвет (null — снять), текст карточки, url веб-страницы, подпись группы.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id ноды'),
          x: num('Левый край'),
          y: num('Верхний край'),
          width: num('Ширина'),
          height: num('Высота'),
          color: { ...colorSchema, type: undefined },
          text: str('Новый текст карточки'),
          url: str('Новый адрес веб-страницы'),
          label: str('Новая подпись группы'),
          role: str('Новая роль терминала/агента/веб-страницы; пустая строка — снять'),
          name: str('Новое имя терминала/агента/веб-страницы')
        },
        required: ['id']
      },
      run(args) {
        const patch: AgentNodePatch = {}
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          const value = opt<number>(args, key)
          if (value !== undefined) patch[key] = value
        }
        if (args.color !== undefined) patch.color = args.color === null ? null : (color(args.color) ?? null)
        for (const key of ['text', 'url', 'label', 'name', 'role'] as const) {
          const value = opt<string>(args, key)
          if (value !== undefined) patch[key] = value
        }
        return deps.call('updateNode', { id: args.id as string, patch })
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
        const fromRef = opt<string>(args, 'from') ?? caller.nodeId
        if (!fromRef) throw new ToolInputError('ты подключён снаружи холста — укажи from')
        const fromNode = await resolveAnyId(fromRef)
        const toNode = await resolveAnyId(args.to as string)
        const fromSide = side(args.from_side, 'from_side')
        const toSide = side(args.to_side, 'to_side')
        const fromEnd = end(args.from_end, 'from_end')
        const toEnd = end(args.to_end, 'to_end')
        const edgeColor = color(args.color)
        const label = opt<string>(args, 'label')
        return deps.call('createEdge', {
          fromNode,
          toNode,
          ...(fromSide ? { fromSide } : {}),
          ...(toSide ? { toSide } : {}),
          ...(fromEnd ? { fromEnd } : {}),
          ...(toEnd ? { toEnd } : {}),
          ...(edgeColor ? { color: edgeColor } : {}),
          ...(label ? { label } : {})
        })
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
          color: { description: colorSchema.description ?? '' },
          ...sides
        },
        required: ['id']
      },
      run(args) {
        const patch: AgentEdgePatch = {}
        const fromSide = side(args.from_side, 'from_side')
        const toSide = side(args.to_side, 'to_side')
        const fromEnd = end(args.from_end, 'from_end')
        const toEnd = end(args.to_end, 'to_end')
        if (fromSide) patch.fromSide = fromSide
        if (toSide) patch.toSide = toSide
        if (fromEnd) patch.fromEnd = fromEnd
        if (toEnd) patch.toEnd = toEnd
        if (args.color !== undefined) patch.color = args.color === null ? null : (color(args.color) ?? null)
        if (args.label !== undefined) patch.label = args.label === null ? null : String(args.label)
        return deps.call('updateEdge', { id: args.id as string, patch })
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
      description: 'Показать человеку ноды: камера вписывает их в экран. Пустой список — вписать весь холст.',
      inputSchema: { type: 'object', properties: { ids: ids('id нод') } },
      run: (args) => deps.call('zoomTo', { ids: opt<string[]>(args, 'ids') ?? [] })
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
        'Выполнить команду приложения по id из list_commands, как будто человек нажал её хоткей. Команды с needsSelection работают по выделению — сначала select.',
      inputSchema: {
        type: 'object',
        properties: { id: str('id команды, например align.left или edit.undo') },
        required: ['id']
      },
      async run(args) {
        const id = args.id as string
        if (!deps.commands.some((c) => c.id === id))
          throw new ToolInputError(`нет команды ${id} — см. list_commands`)
        return deps.call('runCommand', { id })
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
        'Переключить человеку экран на рабочий стол (1…10), как Alt+цифра. Агентов на других столах это не трогает.',
      inputSchema: {
        type: 'object',
        properties: { desktop: { type: 'integer', description: 'Стол 1…10' } },
        required: ['desktop']
      },
      run: (args) => deps.call('switchDesktop', { desktop: args.desktop as number })
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
        'Напечатать текст в другой терминал. enter=true (по умолчанию) — нажать Enter. Для Ctrl+C пошли text="\\u0003" и enter=false. В свой терминал писать нельзя.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя терминала/агента'),
          text: str('Что напечатать'),
          enter: { type: 'boolean', description: 'Нажать Enter после текста (по умолчанию true)' }
        },
        required: ['id', 'text']
      },
      async run(args, caller) {
        const { id, name } = await deps.call('findTerminal', { ref: args.id as string })
        if (id === caller.nodeId)
          throw new ToolInputError('это твой собственный терминал — в себя писать нельзя')
        if (!deps.terminals.isRunning(id))
          throw new ToolInputError(`терминал ${id} не запущен — см. list_terminals`)
        const enter = opt<boolean>(args, 'enter') ?? true
        deps.terminals.write(id, `${args.text as string}${enter ? '\r' : ''}`)
        return { sent: true, id, name: name ?? null }
      }
    },
    {
      name: 'agent_send',
      description:
        'Отправить сообщение агенту (нода kind=agent, Claude Code) по id или имени — как будто человек написал ему в чат и нажал Enter. Многострочный текст уходит целиком. По умолчанию сообщение подписано твоим именем и id, чтобы агент знал, кому отвечать (тоже через agent_send). Ответ читай через terminal_read. Прервать агента: terminal_send text="\\u001b" enter=false.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя агента'),
          message: str('Текст сообщения'),
          sign: { type: 'boolean', description: 'Подписать сообщение отправителем (по умолчанию true)' }
        },
        required: ['id', 'message']
      },
      async run(args, caller) {
        const target = await deps.call('findTerminal', { ref: args.id as string })
        if (target.id === caller.nodeId) throw new ToolInputError('это ты сам — себе писать незачем')
        if (target.kind !== 'agent') {
          throw new ToolInputError(
            `«${target.name ?? target.id}» — не агент, а терминал: используй terminal_send`
          )
        }
        if (!deps.terminals.isRunning(target.id)) throw new ToolInputError(`агент ${target.id} не запущен`)
        let text = args.message as string
        if (opt<boolean>(args, 'sign') ?? true) {
          const from = caller.nodeId
            ? await deps.call('getNodes', { ids: [caller.nodeId] }).then(
                (nodes) => `«${nodes[0]?.name ?? caller.nodeId}» (id ${caller.nodeId})`,
                () => `id ${caller.nodeId}`
              )
            : 'внешнего клиента cnv'
          text = `[сообщение от ${from} через cnv MCP]\n${text}`
        }
        // Bracketed paste: переводы строк внутри не жмут Enter раньше времени.
        deps.terminals.write(target.id, `\x1b[200~${text}\x1b[201~`)
        // Claude Code вставку переваривает не мгновенно — Enter отдельно и чуть позже.
        await deps.sleep(PASTE_SETTLE_MS)
        deps.terminals.write(target.id, '\r')
        return { sent: true, id: target.id, name: target.name ?? null }
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
        'Выполнить JavaScript на веб-странице (id или имя) и вернуть результат (JSON-сериализуемый; промис дожидается). Так можно кликать, заполнять формы, доставать данные: document.querySelector(...).click().',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('id или имя веб-страницы'),
          script: str('Код; значение последнего выражения — результат')
        },
        required: ['id', 'script']
      },
      async run(args) {
        const { node, guest } = await webGuest(args.id as string)
        const result = await deps.web.evaluate(guest, args.script as string)
        return { id: node.id, name: node.name ?? null, result: result === undefined ? null : result }
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
      description: 'Скриншот одной веб-страницы (id или имя) — так, как она отрисована внутри ноды.',
      inputSchema: { type: 'object', properties: { id: str('id или имя веб-страницы') }, required: ['id'] },
      async run(args): Promise<ToolResult> {
        const { guest } = await webGuest(args.id as string)
        const data = await deps.web.capture(guest)
        if (!data) throw new Error('страница пропала, пока снимали')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
      }
    },
    {
      name: 'screenshot',
      description: 'Скриншот окна cnv — посмотреть, как холст выглядит для человека прямо сейчас.',
      inputSchema: { type: 'object', properties: {} },
      async run(): Promise<ToolResult> {
        const data = await deps.screenshot()
        if (!data) throw new Error('окна cnv нет')
        return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
      }
    }
  ]

  /** id ноды по id или имени: агенты зовут соседей по именам. */
  async function resolveAnyId(ref: string): Promise<string> {
    const canvas = await deps.call('getCanvas', { maxText: 0 })
    const lower = ref.trim().toLowerCase()
    const hit =
      canvas.nodes.find((n) => n.id === ref) ?? canvas.nodes.find((n) => n.name?.toLowerCase() === lower)
    if (!hit) throw new ToolInputError(`нет ноды «${ref}»`)
    return hit.id
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
          ...(peer.label ? { label: peer.label } : {})
        }
      })
    }
    return out
  }

  /** Живой гость веб-ноды или понятная ошибка, почему его нет. */
  async function webGuest(
    ref: string
  ): Promise<{ node: AgentMethods['findWeb']['result']['node']; guest: number }> {
    const { node, webContentsId } = await deps.call('findWeb', { ref })
    if (webContentsId === null) {
      throw new ToolInputError(
        `страница «${node.name ?? node.id}» сейчас выгружена (вне экрана или лимит живых) — покажи её через zoom_to и повтори`
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
        return { kind, file: path.isAbsolute(file) ? await deps.importFile(file) : file }
      }
      case 'group': {
        const label = opt<string>(args, 'label')
        return label ? { kind, label } : { kind }
      }
      case 'terminal': {
        const cwd = opt<string>(args, 'cwd')
        const name = opt<string>(args, 'name')
        const role = opt<string>(args, 'role')
        return { kind, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}), ...(role ? { role } : {}) }
      }
      case 'agent': {
        const cwd = opt<string>(args, 'cwd')
        const name = opt<string>(args, 'name')
        const prompt = opt<string>(args, 'prompt')
        const role = opt<string>(args, 'role')
        return {
          kind,
          ...(cwd ? { cwd } : {}),
          ...(name ? { name } : {}),
          ...(role ? { role } : {}),
          ...(prompt ? { prompt } : {})
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
        'Начни с whoami / get_canvas. Новые ноды без координат встают рядом с твоим терминалом. Все правки попадают в историю: человек может отменить их через Ctrl+Z (или ты — run_command edit.undo).',
        'У каждого терминала, агента и веб-страницы есть уникальное имя («Задумчивый Аркадий») — к ним можно обращаться по имени или id (list_terminals, terminal_read, terminal_send, web_read, web_eval).',
        'Веб-страницы — живые браузеры в общей сессии cnv (с логинами человека): web_read, web_eval, web_navigate, web_screenshot.',
        'Холст поделён на 10 рабочих столов (у человека Alt+1 … Alt+0): у каждой ноды есть поле desktop, новые ноды по умолчанию встают на твой стол рядом с тобой. list_desktops — что где, switch_desktop — показать человеку стол, move_to_desktop — перенести ноды.',
        'Связи (стрелки) между нодами — это команда: connections покажет, с кем ты соединён, их имена и роли (роль — кто есть кто). Прицепиться к соседу — create_edge to=<имя>. Свою роль и роли соседей смотри в whoami/connections.',
        'Можно запускать соседних агентов (create_node kind=agent prompt=…), писать им сообщения (agent_send) и читать их ответы (terminal_read); терминалы с командами — kind=terminal command=…, terminal_send.',
        'Файл холста руками не правь — меняй через инструменты, иначе правки разъедутся с открытым окном.'
      ].join('\n')
    }
  }
}
