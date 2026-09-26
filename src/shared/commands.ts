export type CommandSection =
  'file' | 'edit' | 'selection' | 'arrange' | 'align' | 'color' | 'view' | 'create' | 'help'

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
}

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
  'help'
]
