import { COMMANDS, MENU_SECTIONS, SECTION_LABELS } from '@shared/commands'

interface Props {
  onClose(): void
}

export function ShortcutsHelp({ onClose }: Props): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dialog--wide" role="dialog" data-testid="shortcuts">
        <div className="dialog__title">Горячие клавиши</div>
        <div className="shortcuts">
          {MENU_SECTIONS.map((section) => {
            const list = COMMANDS.filter((c) => c.section === section && c.accelerator && !c.hidden)
            if (list.length === 0) return null
            return (
              <div key={section} className="shortcuts__group">
                <div className="settings__title">{SECTION_LABELS[section]}</div>
                {list.map((c) => (
                  <div key={c.id} className="shortcuts__row">
                    <span>{c.label}</span>
                    <kbd>{c.accelerator}</kbd>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
        <div className="dialog__buttons">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}
