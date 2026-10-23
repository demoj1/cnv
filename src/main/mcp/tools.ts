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
        'Где ты запущен: приложение cnv (бесконечный холст), файл холста, workspace и твоя собственная карточка-терминал на нём (id, координаты, папка). Зови первым делом.',
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
                node: own ?? null,
                insideCanvasTerminal: true
              }
            : { nodeId: null, insideCanvasTerminal: false },
          terminalsRunning: deps.terminals.list().length
        }
      }
    },
    {
      name: 'get_canvas',
      description:
        'Весь холст: ноды (id, kind, координаты, текст/файл/url/подпись, cwd терминала), связи, выделение, видимая область. Длинный текст режется до max_text — полный через get_nodes.',
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
          }
        }
      },
      async run(args) {
        const canvas = await deps.call('getCanvas', {
          maxText: Math.max(0, opt<number>(args, 'max_text') ?? 400)
        })
        const kinds = opt<string[]>(args, 'kinds')
        if (kinds?.length) canvas.nodes = canvas.nodes.filter((n) => kinds.includes(n.kind))
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
          name: str('Имя терминала/агента (по умолчанию придумается)'),
          prompt: str('Первое задание агенту — для kind=agent'),
          command: str('Команда, которую выполнить в новом терминале (Enter добавится сам)'),
          x: num('Левый край, мировые координаты'),
          y: num('Верхний край'),
          width: num('Ширина'),
          height: num('Высота'),
          near: str('id ноды, рядом с которой поставить'),
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
          name: str('Новое имя терминала/агента')
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
        for (const key of ['text', 'url', 'label', 'name'] as const) {
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
      name: 'create_edge',
      description: 'Связь (стрелка) между двумя нодами, с подписью и цветом.',
      inputSchema: {
        type: 'object',
        properties: {
          from: str('id исходной ноды'),
          to: str('id целевой ноды'),
          label: str('Подпись на связи'),
          color: colorSchema,
          ...sides
        },
        required: ['from', 'to']
      },
      run(args) {
        const fromSide = side(args.from_side, 'from_side')
        const toSide = side(args.to_side, 'to_side')
        const fromEnd = end(args.from_end, 'from_end')
        const toEnd = end(args.to_end, 'to_end')
        const edgeColor = color(args.color)
        const label = opt<string>(args, 'label')
        return deps.call('createEdge', {
          fromNode: args.from as string,
          toNode: args.to as string,
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
              kind: n.kind,
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
      case 'web':
        return { kind, url: need('url') }
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
        return { kind, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) }
      }
      case 'agent': {
        const cwd = opt<string>(args, 'cwd')
        const name = opt<string>(args, 'name')
        const prompt = opt<string>(args, 'prompt')
        return { kind, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}), ...(prompt ? { prompt } : {}) }
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
        'У каждого терминала и агента есть уникальное имя («Задумчивый Аркадий») — к ним можно обращаться по имени или id (list_terminals, terminal_read, terminal_send).',
        'Можно запускать соседних агентов (create_node kind=agent prompt=…), писать им сообщения (agent_send) и читать их ответы (terminal_read); терминалы с командами — kind=terminal command=…, terminal_send.',
        'Файл холста руками не правь — меняй через инструменты, иначе правки разъедутся с открытым окном.'
      ].join('\n')
    }
  }
}
