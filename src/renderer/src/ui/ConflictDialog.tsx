import type { ExternalChange } from '@shared/api'
import type { ConflictChoice } from '@renderer/workspace/useCanvasFile'

interface Props {
  change: ExternalChange
  onChoose(choice: ConflictChoice): void
}

export function ConflictDialog({ change, onChoose }: Props): React.JSX.Element {
  const removed = change.kind === 'unlink'
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" data-testid="conflict-dialog">
        <div className="dialog__title">{removed ? 'Файл удалён снаружи' : 'Файл изменён снаружи'}</div>
        <div className="dialog__text">
          {change.relPath}
          <br />
          Есть несохранённые изменения. Что делать?
        </div>
        <div className="dialog__buttons">
          {!removed && (
            <button type="button" onClick={() => onChoose('reload')}>
              Перезагрузить с диска
            </button>
          )}
          <button type="button" onClick={() => onChoose('keep')}>
            Оставить своё
          </button>
          <button type="button" onClick={() => onChoose('save-copy')}>
            Сохранить копию
          </button>
        </div>
      </div>
    </div>
  )
}
