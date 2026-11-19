import { useEffect, useRef, useState } from 'react'
import {
  DB_KINDS,
  dbFormReady,
  dbSpec,
  plural,
  type DbForm,
  type DbKind,
  type DbTablesResult
} from '@shared/database'

interface Props {
  onSubmit(spec: string): void
  onCancel(): void
}

const EMPTY: DbForm = {
  kind: 'postgres',
  host: 'localhost',
  port: '',
  database: '',
  user: '',
  password: '',
  file: '',
  url: '',
  table: '',
  write: false
}

/**
 * Подключение базы: тип, адрес и вход — полями; «Подключиться» проверяет связь и заполняет
 * список таблиц — подключить всю базу или одну таблицу; доступ — только чтение или и запись.
 */
export function DatabaseDialog({ onSubmit, onCancel }: Props): React.JSX.Element {
  const [form, setForm] = useState<DbForm>(EMPTY)
  // «Подключиться»: ещё не жали, ждём ответа или таблицы базы / причина, почему не вышло.
  const [conn, setConn] = useState<null | 'loading' | DbTablesResult>(null)
  // Ответ на устаревшую форму (поля поменяли, пока ждали) не должен перетереть свежий.
  const attempt = useRef(0)

  // Esc закрывает окно, где бы ни был фокус. Подписка одна на всё время окна: Esc сначала
  // снимает выделение на холсте, App перерисовывается — переподписанный слушатель это
  // нажатие уже пропустил бы.
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const kind = DB_KINDS.find((k) => k.id === form.kind)!
  const ready = dbFormReady(form)
  const server = form.kind === 'postgres' || form.kind === 'mysql'
  const tables = conn && conn !== 'loading' && 'tables' in conn ? conn.tables : null

  /** Поменяли, куда подключаться, — прежний список таблиц уже не про эту базу. */
  const change = (patch: Partial<DbForm>): void => {
    attempt.current++
    setForm((f) => ({ ...f, ...patch, table: '' }))
    setConn(null)
  }

  const connect = async (): Promise<void> => {
    if (!ready || conn === 'loading') return
    const id = ++attempt.current
    setConn('loading')
    const res = await window.api.database.tables(dbSpec({ ...form, table: '', write: false }))
    if (id === attempt.current) setConn(res)
  }

  const submit = (): void => {
    if (ready) onSubmit(dbSpec(form))
  }

  const chooseFile = async (): Promise<void> => {
    const [file] = await window.api.files.choose([
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
      { name: 'Все файлы', extensions: ['*'] }
    ])
    if (file) change({ file })
  }

  const input = (key: keyof DbForm, placeholder: string): React.JSX.Element => (
    <input
      className="dialog__input"
      data-field={key}
      value={String(form[key])}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => change({ [key]: e.target.value } as Partial<DbForm>)}
    />
  )

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog db-dialog"
        role="dialog"
        data-testid="db-dialog"
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && submit()}
      >
        <div className="dialog__title">🛢 База данных</div>
        <div className="db-dialog__grid">
          <label htmlFor="db-kind">Тип</label>
          <select
            id="db-kind"
            className="dialog__input"
            data-field="kind"
            value={form.kind}
            autoFocus
            onChange={(e) => change({ kind: e.target.value as DbKind })}
          >
            {DB_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>

          {server && (
            <>
              <label>Сервер</label>
              <div className="db-dialog__pair">
                {input('host', 'localhost')}
                {input('port', kind.port ?? '')}
              </div>
              <label>База</label>
              {input('database', 'shop')}
              <label>Вход</label>
              <div className="db-dialog__pair">
                {input('user', 'логин')}
                {input('password', 'пароль или ${PGPASS}')}
              </div>
              <span />
              <div className="db-dialog__hint">
                <code>{'${ПЕРЕМЕННАЯ}'}</code> — пароль из окружения cnv, в файл холста не попадёт
              </div>
            </>
          )}

          {form.kind === 'sqlite' && (
            <>
              <label>Файл</label>
              <div className="db-dialog__pair">
                {input('file', 'data/shop.db — путь от папки холста')}
                <button type="button" className="db-dialog__btn" onClick={() => void chooseFile()}>
                  Выбрать…
                </button>
              </div>
            </>
          )}

          {form.kind === 'url' && (
            <>
              <label>Строка</label>
              {input('url', 'postgres://user@host:5432/db?sslmode=require')}
            </>
          )}

          <label htmlFor="db-table">Таблица</label>
          <div className="db-dialog__pair">
            <select
              id="db-table"
              className="dialog__input"
              data-field="table"
              value={form.table}
              disabled={!tables}
              title={tables ? '' : 'Сначала «Подключиться» — загрузить список таблиц'}
              onChange={(e) => setForm((f) => ({ ...f, table: e.target.value }))}
            >
              <option value="">Вся база</option>
              {tables?.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.type === 'view' ? `${t.name} (view)` : t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="db-dialog__btn"
              data-testid="db-connect"
              disabled={!ready}
              onClick={() => void connect()}
            >
              {conn === 'loading' ? 'Подключаюсь…' : 'Подключиться'}
            </button>
          </div>

          <label htmlFor="db-write">Доступ</label>
          <select
            id="db-write"
            className="dialog__input"
            data-field="write"
            value={form.write ? 'write' : 'read'}
            onChange={(e) => setForm((f) => ({ ...f, write: e.target.value === 'write' }))}
          >
            <option value="read">Только чтение</option>
            <option value="write">Чтение и запись</option>
          </select>

          {conn && conn !== 'loading' && (
            <>
              <span />
              <div
                className={`db-dialog__status db-dialog__status--${'error' in conn ? 'error' : 'ok'}`}
                data-testid="db-status"
              >
                {'error' in conn
                  ? conn.error
                  : `✓ подключено: ${plural(conn.tables.length, 'таблица', 'таблицы', 'таблиц')}`}
              </div>
            </>
          )}
        </div>

        <div className="db-dialog__spec" title="Эта строка ляжет на карточку — по ней базу найдут агенты">
          {ready ? dbSpec(form) : ' '}
        </div>

        <div className="dialog__buttons">
          <button type="button" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="db-dialog__primary" disabled={!ready} onClick={submit}>
            Создать карточку
          </button>
        </div>
      </div>
    </div>
  )
}
