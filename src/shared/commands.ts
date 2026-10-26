export type CommandSection =
  'file' | 'edit' | 'selection' | 'arrange' | 'align' | 'color' | 'view' | 'desktop' | 'create' | 'help'

export interface CommandDef {
  id: string
  label: string
  section: CommandSection
  accelerator?: string
  /** Требует выделения хотя бы одной ноды. */
  needsSelection?: boolean
  /** Требует выделения из двух и более нод. */
  needsMultiSelection?: boolean
  /** В меню не показывается, только хоткей. */
  hidden?: boolean
  separatorBefore?: boolean
  /** Срабатывает и из терминала, редактора и веб-страницы — не только с холста. */
  global?: boolean
}

/** Столы 1…10: Alt+1 … Alt+9, Alt+0 — переключить, с Shift — перенести туда выделенное. */
const DESKTOP_COMMANDS: CommandDef[] = Array.from({ length: 10 }, (_, i) => i + 1).flatMap((n) => {
  const key = String(n % 10)
  return [
    {
      id: `desktop.${n}`,
      label: `Стол ${n}`,
      section: 'desktop' as const,
      accelerator: `Alt+${key}`,
      global: true
    },
    {
      id: `desktop.move${n}`,
      label: `Перенести выделенное на стол ${n}`,
      section: 'desktop' as const,
      accelerator: `Alt+Shift+${key}`,
      needsSelection: true,
      hidden: true,
      global: true
    }
  ]
})

export const COMMANDS: readonly CommandDef[] = [
  { id: 'canvas.save', label: 'Сохранить', section: 'file', accelerator: 'CmdOrCtrl+S' },
  {
    id: 'canvas.chooseFile',
    label: 'Хранить канвас в файле…',
    section: 'file',
    accelerator: 'CmdOrCtrl+Shift+O',
    separatorBefore: true
  },

  { id: 'edit.undo', label: 'Отменить', section: 'edit', accelerator: 'CmdOrCtrl+Z' },
  { id: 'edit.redo', label: 'Повторить', section: 'edit', accelerator: 'CmdOrCtrl+Shift+Z' },
  { id: 'edit.redoAlt', label: 'Повторить', section: 'edit', accelerator: 'CmdOrCtrl+Y', hidden: true },
  {
    id: 'edit.cut',
    label: 'Вырезать',
    section: 'edit',
    accelerator: 'CmdOrCtrl+X',
    separatorBefore: true,
    needsSelection: true
  },
  { id: 'edit.copy', label: 'Копировать', section: 'edit', accelerator: 'CmdOrCtrl+C', needsSelection: true },
  { id: 'edit.paste', label: 'Вставить', section: 'edit', accelerator: 'CmdOrCtrl+V' },
  {
    id: 'edit.duplicate',
    label: 'Дублировать',
    section: 'edit',
    accelerator: 'CmdOrCtrl+D',
    needsSelection: true
  },
  { id: 'edit.delete', label: 'Удалить', section: 'edit', accelerator: 'Delete', needsSelection: true },
  {
    id: 'edit.resetSize',
    label: 'Сбросить к исходному размеру',
    section: 'edit',
    separatorBefore: true,
    needsSelection: true
  },

  { id: 'selection.all', label: 'Выделить всё', section: 'selection', accelerator: 'CmdOrCtrl+A' },
  {
    id: 'selection.none',
    label: 'Снять выделение',
    section: 'selection',
    accelerator: 'Escape',
    hidden: true
  },

  { id: 'create.text', label: 'Текстовая карточка', section: 'create', accelerator: 'CmdOrCtrl+T' },
  { id: 'create.web', label: 'Веб-страница…', section: 'create', accelerator: 'CmdOrCtrl+Shift+L' },
  { id: 'create.file', label: 'Файл…', section: 'create', accelerator: 'CmdOrCtrl+Shift+F' },
  { id: 'create.terminal', label: 'Терминал', section: 'create', accelerator: 'CmdOrCtrl+Shift+T' },
  { id: 'create.agent', label: 'Агент', section: 'create', accelerator: 'CmdOrCtrl+Shift+A' },
  { id: 'create.portal', label: 'Портал к другому cnv', section: 'create' },
  { id: 'create.timer', label: 'Таймер для агентов', section: 'create' },
  { id: 'node.rename', label: 'Переименовать…', section: 'edit', accelerator: 'F2', needsSelection: true },
  { id: 'node.role', label: 'Роль…', section: 'edit', needsSelection: true },
  { id: 'node.icon', label: 'Значок агента…', section: 'edit', needsSelection: true },
  { id: 'agent.collapse', label: 'Свернуть / развернуть агента', section: 'edit', needsSelection: true },
  {
    id: 'create.group',
    label: 'Сгруппировать выделенное',
    section: 'create',
    accelerator: 'CmdOrCtrl+G',
    needsSelection: true
  },
  {
    id: 'create.ungroup',
    label: 'Разгруппировать',
    section: 'create',
    accelerator: 'CmdOrCtrl+Shift+G',
    needsSelection: true
  },

  {
    id: 'arrange.front',
    label: 'На передний план',
    section: 'arrange',
    accelerator: 'CmdOrCtrl+Shift+]',
    needsSelection: true
  },
  {
    id: 'arrange.forward',
    label: 'Шаг вперёд',
    section: 'arrange',
    accelerator: 'CmdOrCtrl+]',
    needsSelection: true
  },
  {
    id: 'arrange.backward',
    label: 'Шаг назад',
    section: 'arrange',
    accelerator: 'CmdOrCtrl+[',
    needsSelection: true
  },
  {
    id: 'arrange.back',
    label: 'На задний план',
    section: 'arrange',
    accelerator: 'CmdOrCtrl+Shift+[',
    needsSelection: true
  },

  { id: 'align.left', label: 'Выровнять по левому краю', section: 'align', needsMultiSelection: true },
  { id: 'align.centerX', label: 'Выровнять по центру (гориз.)', section: 'align', needsMultiSelection: true },
  { id: 'align.right', label: 'Выровнять по правому краю', section: 'align', needsMultiSelection: true },
  {
    id: 'align.top',
    label: 'Выровнять по верхнему краю',
    section: 'align',
    needsMultiSelection: true,
    separatorBefore: true
  },
  { id: 'align.centerY', label: 'Выровнять по центру (верт.)', section: 'align', needsMultiSelection: true },
  { id: 'align.bottom', label: 'Выровнять по нижнему краю', section: 'align', needsMultiSelection: true },
  {
    id: 'align.distributeX',
    label: 'Распределить по горизонтали',
    section: 'align',
    needsMultiSelection: true,
    separatorBefore: true
  },
  {
    id: 'align.distributeY',
    label: 'Распределить по вертикали',
    section: 'align',
    needsMultiSelection: true
  },
  {
    id: 'align.sameWidth',
    label: 'Уравнять ширину',
    section: 'align',
    needsMultiSelection: true,
    separatorBefore: true
  },
  { id: 'align.sameHeight', label: 'Уравнять высоту', section: 'align', needsMultiSelection: true },
  { id: 'align.sameSize', label: 'Уравнять размер', section: 'align', needsMultiSelection: true },
  {
    id: 'align.packRow',
    label: 'Упаковать в ряд',
    section: 'align',
    needsMultiSelection: true,
    separatorBefore: true
  },
  { id: 'align.packGrid', label: 'Упаковать в сетку', section: 'align', needsMultiSelection: true },

  { id: 'color.none', label: 'Без цвета', section: 'color', needsSelection: true },
  { id: 'color.1', label: 'Красный', section: 'color', needsSelection: true },
  { id: 'color.2', label: 'Оранжевый', section: 'color', needsSelection: true },
  { id: 'color.3', label: 'Жёлтый', section: 'color', needsSelection: true },
  { id: 'color.4', label: 'Зелёный', section: 'color', needsSelection: true },
  { id: 'color.5', label: 'Голубой', section: 'color', needsSelection: true },
  { id: 'color.6', label: 'Фиолетовый', section: 'color', needsSelection: true },

  { id: 'view.zoomFit', label: 'Вписать всё', section: 'view', accelerator: 'Shift+1' },
  {
    id: 'view.zoomSelection',
    label: 'Вписать выделение',
    section: 'view',
    accelerator: 'Shift+2',
    needsSelection: true
  },
  { id: 'view.zoomReset', label: 'Масштаб 100%', section: 'view', accelerator: 'CmdOrCtrl+0' },
  { id: 'view.zoomIn', label: 'Увеличить', section: 'view', accelerator: 'CmdOrCtrl+=' },
  { id: 'view.zoomOut', label: 'Уменьшить', section: 'view', accelerator: 'CmdOrCtrl+-' },
  {
    id: 'view.uiScaleUp',
    label: 'Интерфейс крупнее',
    section: 'view',
    accelerator: 'CmdOrCtrl+Shift+=',
    separatorBefore: true
  },
  { id: 'view.uiScaleDown', label: 'Интерфейс мельче', section: 'view', accelerator: 'CmdOrCtrl+Shift+-' },
  {
    id: 'view.toggleGrid',
    label: 'Сетка',
    section: 'view',
    accelerator: "CmdOrCtrl+'",
    separatorBefore: true
  },
  { id: 'view.toggleSnap', label: 'Привязка к сетке', section: 'view', accelerator: "CmdOrCtrl+Shift+'" },
  {
    id: 'view.settings',
    label: 'Настройки',
    section: 'view',
    accelerator: 'CmdOrCtrl+,',
    separatorBefore: true
  },
  {
    id: 'view.devtools',
    label: 'Инструменты разработчика',
    section: 'view',
    accelerator: 'F12',
    separatorBefore: true
  },

  ...DESKTOP_COMMANDS,

  { id: 'help.shortcuts', label: 'Горячие клавиши', section: 'help', accelerator: 'F1' }
]

export const COMMAND_BY_ID: ReadonlyMap<string, CommandDef> = new Map(COMMANDS.map((c) => [c.id, c]))

export const SECTION_LABELS: Record<CommandSection, string> = {
  file: 'Файл',
  edit: 'Правка',
  selection: 'Выделение',
  create: 'Создать',
  arrange: 'Порядок',
  align: 'Выравнивание',
  color: 'Цвет',
  view: 'Вид',
  desktop: 'Столы',
  help: 'Справка'
}

export const MENU_SECTIONS: readonly CommandSection[] = [
  'file',
  'edit',
  'selection',
  'create',
  'arrange',
  'align',
  'color',
  'view',
  'desktop',
  'help'
]

/**
 * Меню — деревья команд: строка — id команды, `'-'` — разделитель, объект — подменю.
 * Из одних и тех же кусков собираются и меню окна, и ПКМ: «Действия» над выделенным везде
 * одинаковые и спрятаны на уровень глубже, чтобы меню не разрастались на весь экран.
 */
export type MenuEntry = string | MenuGroup
export interface MenuGroup {
  label: string
  items: readonly MenuEntry[]
}

export const SEP = '-'

const COLOR_MENU: MenuGroup = {
  label: 'Цвет',
  items: ['color.none', 'color.1', 'color.2', 'color.3', 'color.4', 'color.5', 'color.6']
}

const ARRANGE_MENU: MenuGroup = {
  label: 'Порядок',
  items: ['arrange.front', 'arrange.forward', 'arrange.backward', 'arrange.back']
}

const ALIGN_MENU: MenuGroup = {
  label: 'Выравнивание',
  items: [
    'align.left',
    'align.centerX',
    'align.right',
    SEP,
    'align.top',
    'align.centerY',
    'align.bottom',
    SEP,
    'align.distributeX',
    'align.distributeY',
    SEP,
    'align.sameWidth',
    'align.sameHeight',
    'align.sameSize',
    SEP,
    'align.packRow',
    'align.packGrid'
  ]
}

const GROUP_MENU: MenuGroup = { label: 'Группа', items: ['create.group', 'create.ungroup'] }

/** Всё, что делают с выделенными нодами, — одним подменю. */
export const ACTIONS_MENU: MenuGroup = {
  label: 'Действия',
  items: [
    COLOR_MENU,
    ARRANGE_MENU,
    ALIGN_MENU,
    GROUP_MENU,
    SEP,
    'edit.resetSize',
    'view.zoomSelection',
    'node.icon'
  ]
}

export const CREATE_MENU: MenuGroup = {
  label: 'Создать',
  items: [
    'create.text',
    'create.web',
    'create.file',
    'create.terminal',
    'create.agent',
    'create.portal',
    'create.timer'
  ]
}

const DESKTOPS_MENU: MenuGroup = {
  label: 'Столы',
  items: Array.from({ length: 10 }, (_, i) => `desktop.${i + 1}`)
}

/** ПКМ по ноде или выделению. */
export const NODE_CONTEXT_MENU: readonly MenuEntry[] = [
  'edit.cut',
  'edit.copy',
  'edit.duplicate',
  'edit.delete',
  SEP,
  'node.rename',
  'node.role',
  'agent.collapse',
  SEP,
  ACTIONS_MENU
]

/** ПКМ по пустому холсту. */
export const CANVAS_CONTEXT_MENU: readonly MenuEntry[] = [
  CREATE_MENU,
  SEP,
  'edit.paste',
  'selection.all',
  SEP,
  'view.zoomFit',
  'view.toggleGrid',
  'view.settings'
]

/** Меню окна: пять пунктов вместо десяти, подробности — в подменю. */
export const APP_MENU: readonly MenuGroup[] = [
  { label: 'Файл', items: ['canvas.save', 'canvas.chooseFile'] },
  {
    label: 'Правка',
    items: [
      'edit.undo',
      'edit.redo',
      SEP,
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.duplicate',
      'edit.delete',
      SEP,
      'selection.all',
      SEP,
      'node.rename',
      'node.role',
      'node.icon',
      'agent.collapse',
      SEP,
      ACTIONS_MENU
    ]
  },
  CREATE_MENU,
  {
    label: 'Вид',
    items: [
      'view.zoomFit',
      'view.zoomSelection',
      'view.zoomReset',
      'view.zoomIn',
      'view.zoomOut',
      SEP,
      DESKTOPS_MENU,
      SEP,
      'view.uiScaleUp',
      'view.uiScaleDown',
      SEP,
      'view.toggleGrid',
      'view.toggleSnap',
      SEP,
      'view.settings',
      'view.devtools'
    ]
  },
  { label: 'Справка', items: ['help.shortcuts'] }
]

/** Все id команд в дереве меню — для проверки, что ни одна видимая команда не потерялась. */
export function menuCommandIds(entries: readonly MenuEntry[]): string[] {
  return entries.flatMap((e) => (typeof e === 'string' ? (e === SEP ? [] : [e]) : menuCommandIds(e.items)))
}
