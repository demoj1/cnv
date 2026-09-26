# cnv

Десктопный бесконечный холст: markdown-карточки, картинки, PDF и **живые веб-страницы**
на одном полотне. Файлы — [JSON Canvas 1.0](https://jsoncanvas.org), тот же формат, что
у Obsidian Canvas. Целевая платформа — Linux (Wayland), macOS и Windows собираются.

## Разработка

```bash
npm install
npm run dev          # electron-vite dev, HMR renderer
npm test             # vitest, unit-тесты ядра
npm run test:e2e     # playwright в режиме Electron (гоняется по собранному out/)
npm run typecheck    # tsc по обоим проектам
npm run lint         # eslint
npm run format       # prettier
```

e2e требуют собранного приложения:

```bash
npm run build && npm run test:e2e
```

## Сборка

```bash
npm run build:linux  # AppImage + .deb в release/
npm run build:win    # nsis
npm run build:mac    # dmg
```

Под X11 вместо нативного Wayland: `npm run dev -- --ozone-platform=x11`
(подробности — `docs/decisions.md`, ADR-005).

## Архитектура

Четыре слоя, разнесённые по процессам. **main** держит весь файловый I/O: открытый
workspace (папка с `.canvas`-файлами и вложениями), атомарную запись через временный файл
и `rename`, watcher, настройки, кеш снимков веб-страниц и протокол `canvas-file://`,
который отдаёт файлы **только** изнутри корня workspace — с проверкой реального пути, так
что ни `..`, ни симлинк наружу не проходят. **preload** через `contextBridge` отдаёт
renderer единственный объект `window.api` — узкий типизированный фасад над IPC
(`src/shared/api.ts`); `ipcRenderer` наружу не течёт. Окно живёт с
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` и строгим CSP без
`unsafe-eval`, а гостевые `<webview>` принудительно ужесточаются в `will-attach-webview` и
сидят в отдельной persistent-сессии `persist:web`.

**core** — чистый TypeScript без React и Electron: модель документа JSON Canvas, камера и
геометрия, команды с историей, snapping и выравнивание, spatial index, сериализация.
Именно он покрыт unit-тестами. **renderer** рисует холст на DOM: мировой контейнер с
`transform: translate() scale()`, под ним слой сетки, SVG-слой рёбер, слой нод и оверлей
интеракций в экранных координатах. Горячий путь мимо React: камера — отдельный
`CameraController`, который пишет `style.transform` напрямую из подписки, а React получает
её значение не чаще раза за кадр и только там, где от неё что-то зависит (culling, LOD).

## Горячие клавиши

Единственный источник правды — `src/shared/commands.ts`; из него же строится меню
приложения, так что список в меню и реальные биндинги не могут разойтись.

| Клавиши | Действие |
|---|---|
| `Ctrl+Shift+O` | открыть папку-workspace |
| `Ctrl+N` / `Ctrl+S` / `Ctrl+W` | новый канвас / сохранить / закрыть |
| `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y` | отменить, повторить |
| `Ctrl+X`, `Ctrl+C`, `Ctrl+V`, `Ctrl+D` | вырезать, копировать, вставить, дублировать |
| `Delete` | удалить выделенное |
| `Ctrl+A` / `Esc` | выделить всё / снять выделение |
| `Ctrl+T`, `Ctrl+Shift+L`, `Ctrl+Shift+F` | новая карточка, веб-нода, файл |
| `Ctrl+G` / `Ctrl+Shift+G` | сгруппировать / разгруппировать |
| `Ctrl+]`, `Ctrl+[`, `Ctrl+Shift+]`, `Ctrl+Shift+[` | z-order |
| `Shift+1` / `Shift+2` | вписать всё / вписать выделение |
| `Ctrl+0`, `Ctrl+=`, `Ctrl+-` | 100%, увеличить, уменьшить |
| `Ctrl+'` / `Ctrl+Shift+'` | сетка / привязка к сетке |
| `Ctrl+B`, `Ctrl+,`, `F1`, `F12` | панель, настройки, справка, devtools |

Мышь: колёсико — pan по Y, `Shift`+колёсико — pan по X, `Ctrl`+колёсико и пинч — zoom к
курсору. Pan средней кнопкой или `Space`+ЛКМ.

## Документы

- `docs/spike-results.md` — что реально померили перед тем, как писать код.
- `docs/decisions.md` — ADR: почему `<webview>`, почему без `ozone-platform-hint` и т.д.
- `docs/checklist.md` — разбор ТЗ по пунктам.
- `LOG.md` — лог разработки.
