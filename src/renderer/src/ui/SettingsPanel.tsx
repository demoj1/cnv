import type { DeepPartial } from '@shared/api'
import { UI_SCALES, type Settings, type ThemeMode, type WindowOpenBehavior } from '@shared/settings'

interface Props {
  settings: Settings
  onClose(): void
}

const patch = (value: DeepPartial<Settings>): void => void window.api.settings.patch(value)

export function SettingsPanel({ settings, onClose }: Props): React.JSX.Element {
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog dialog--wide" role="dialog" data-testid="settings">
        <div className="dialog__title">Настройки</div>

        <Section title="Вид">
          <Row label="Тема">
            <select
              value={settings.theme}
              onChange={(e) => patch({ theme: e.target.value as ThemeMode })}
              data-setting="theme"
            >
              <option value="system">системная</option>
              <option value="light">светлая</option>
              <option value="dark">тёмная</option>
            </select>
          </Row>
          <Row label="Масштаб интерфейса">
            <select
              value={settings.uiScale}
              onChange={(e) => patch({ uiScale: Number(e.target.value) })}
              data-setting="uiScale"
            >
              {UI_SCALES.map((v) => (
                <option key={v} value={v}>
                  ×{v.toFixed(2).replace(/\.?0+$/, '')}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Сетка">
            <input
              type="checkbox"
              checked={settings.grid.show}
              onChange={(e) => patch({ grid: { show: e.target.checked } })}
              data-setting="gridShow"
            />
          </Row>
          <Row label="Шаг сетки">
            <input
              type="number"
              min={2}
              max={200}
              value={settings.grid.size}
              onChange={(e) => patch({ grid: { size: Number(e.target.value) || 20 } })}
            />
          </Row>
          <Row label="Колёсико масштабирует">
            <input
              type="checkbox"
              checked={settings.camera.wheelZooms}
              onChange={(e) => patch({ camera: { wheelZooms: e.target.checked } })}
            />
          </Row>
        </Section>

        <Section title="Привязка">
          <Row label="Привязка к сетке">
            <input
              type="checkbox"
              checked={settings.grid.snap}
              onChange={(e) => patch({ grid: { snap: e.target.checked } })}
              data-setting="gridSnap"
            />
          </Row>
          <Row label="Смарт-направляющие">
            <input
              type="checkbox"
              checked={settings.snapping.smartGuides}
              onChange={(e) => patch({ snapping: { smartGuides: e.target.checked } })}
              data-setting="smartGuides"
            />
          </Row>
          <Row label="Равные отступы">
            <input
              type="checkbox"
              checked={settings.snapping.equalSpacing}
              onChange={(e) => patch({ snapping: { equalSpacing: e.target.checked } })}
            />
          </Row>
          <Row label="Порог, экранных px">
            <input
              type="number"
              min={1}
              max={40}
              value={settings.snapping.thresholdPx}
              onChange={(e) => patch({ snapping: { thresholdPx: Number(e.target.value) || 6 } })}
            />
          </Row>
        </Section>

        <Section title="Веб-страницы">
          <Row label="Живых одновременно">
            <input
              type="number"
              min={0}
              max={24}
              value={settings.web.liveLimit}
              onChange={(e) => patch({ web: { liveLimit: Number(e.target.value) || 0 } })}
              data-setting="liveLimit"
            />
          </Row>
          <Row label="Порог zoom для выгрузки">
            <input
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={settings.web.lodZoomThreshold}
              onChange={(e) => patch({ web: { lodZoomThreshold: Number(e.target.value) || 0 } })}
            />
          </Row>
          <Row label="Выгружать вне экрана через, с">
            <input
              type="number"
              min={1}
              max={600}
              value={Math.round(settings.web.offscreenUnloadMs / 1000)}
              onChange={(e) => patch({ web: { offscreenUnloadMs: (Number(e.target.value) || 20) * 1000 } })}
            />
          </Row>
          <Row label="window.open">
            <select
              value={settings.web.windowOpen}
              onChange={(e) => patch({ web: { windowOpen: e.target.value as WindowOpenBehavior } })}
            >
              <option value="new-node">новая нода рядом</option>
              <option value="external-browser">внешний браузер</option>
            </select>
          </Row>
        </Section>

        <Section title="Ноды и файлы">
          <Row label="Порог zoom для упрощённого вида">
            <input
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={settings.nodes.lodZoomThreshold}
              onChange={(e) => patch({ nodes: { lodZoomThreshold: Number(e.target.value) || 0 } })}
            />
          </Row>
          <Row label="Авто-высота текстовых карточек">
            <input
              type="checkbox"
              checked={settings.nodes.textAutoHeight}
              onChange={(e) => patch({ nodes: { textAutoHeight: e.target.checked } })}
            />
          </Row>
          <Row label="Папка вложений">
            <input
              value={settings.workspace.attachmentsDir}
              onChange={(e) => patch({ workspace: { attachmentsDir: e.target.value || 'attachments' } })}
            />
          </Row>
          <Row label="Перетащенный .md">
            <select
              value={settings.workspace.markdownDrop}
              onChange={(e) =>
                patch({ workspace: { markdownDrop: e.target.value as 'embed-content' | 'file-node' } })
              }
            >
              <option value="file-node">ссылкой на файл</option>
              <option value="embed-content">содержимым карточки</option>
            </select>
          </Row>
        </Section>

        <div className="dialog__buttons">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="settings__section">
      <div className="settings__title">{title}</div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="settings__row">
      <span>{label}</span>
      {children}
    </label>
  )
}
