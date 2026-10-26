import { useMemo } from 'react'
import type { CanvasDoc } from '@core/document'
import { desktopKey, desktopSummary } from '@core/desktops'

interface Props {
  doc: CanvasDoc
  current: number
  onSwitch(desktop: number): void
}

/** Полоска столов: текущий подсвечен, занятые отмечены. Клик — то же, что Alt+цифра. */
export function DesktopBar({ doc, current, onSwitch }: Props): React.JSX.Element {
  const summary = useMemo(() => desktopSummary(doc), [doc])
  return (
    <div className="panel desktops" data-testid="desktops">
      {summary.map(({ desktop, nodes }) => {
        const classes = ['panel__btn', 'desktops__item']
        if (desktop === current) classes.push('desktops__item--current', 'panel__btn--current')
        if (nodes > 0) classes.push('desktops__item--busy')
        return (
          <button
            key={desktop}
            type="button"
            className={classes.join(' ')}
            title={`Стол ${desktop} (Alt+${desktopKey(desktop)}) · нод: ${nodes}`}
            data-desktop={desktop}
            onClick={() => onSwitch(desktop)}
          >
            {desktopKey(desktop)}
          </button>
        )
      })}
    </div>
  )
}
