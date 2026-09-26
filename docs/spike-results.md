# Фаза 0 — результаты спайка

Дата: 26.09.2026. Стенд: CachyOS, Hyprland (Wayland, `wayland-1`, XWayland на `:0`),
экран 3840×2160, `devicePixelRatio` 0.953125 (дробное масштабирование).
Electron **44.4.5** / Chromium **152.0.7977.130**, Node 26.9.0, npm 12.0.2.

Всё меряно, не на глаз: голый Electron в `spike/` + Playwright (`_electron.launch`),
скрипты `spike/run-spike*.mjs`, сырые результаты — `spike/results*.json`.
Воспроизвести: `cd spike && node run-spike.mjs [hit|iframe|session|overlay|snapshot|memory|platform]`.

---

## 1. `<webview>` внутри `transform: scale()` — ✅

Нода 400×300 в мировых координатах, камера `translate(50,60) scale(z)`. Клик в точку,
отстоящую на четверть ширины и высоты ноды от её левого верхнего угла; гость (локальная
страница) репортит собственные `clientX/clientY`.

| zoom | экранный размер ноды | ожидали | гость сказал | Δ |
|---|---|---|---|---|
| 0.5 | 201×151 | 100, 75 | 99, 74 | −1, −1 |
| 1.0 | 402×302 | 100, 75 | 99, 74 | −1, −1 |
| 2.0 | 804×604 | 100, 75 | 99, 74 | −1, −1 |

**Вывод.** Гость держит собственный layout (400×300 CSS-px) независимо от zoom, визуально
масштабируется CSS-трансформом вместе с остальным миром, хит-тест попадает точно.
Компенсация через `setZoomFactor` гостя **не нужна**.

Расхождение в 1 px — не ошибка хит-теста: при `devicePixelRatio` 0.953 координата, которую
Playwright отправляет в Chromium, округляется в device-пикселях и возвращается на 1 CSS-px
левее (проверено отдельно: `mouse.move(420, …)` → обработчик видит `clientX: 419`).

### Чёткость

Скриншоты `spike/crisp-{0_5,1,2}.png`, `spike/wc-z{1,2}-{during,settled}.png`. На zoom 2
и текст DOM-карточки, и содержимое `<webview>` растеризуются заново — размытия нет.
`will-change: transform` снимается через 150 мс после последнего движения камеры
(`willChangeAfterSettle: "auto"`), Chromium перерастеризует контент.

---

## 2. Сайты, запрещающие iframe — ✅

Контроль: `curl -I` на тех же адресах отдаёт `X-Frame-Options: deny` (github) и
`SAMEORIGIN` (google, youtube) — то есть запрет реальный.

| сайт | `<webview>` | `<iframe>` в том же окне |
|---|---|---|
| github.com | загрузился, `did-finish-load`, title «github.com» | фрейм ушёл в `chrome-error://chromewebdata/` |
| google.com | загрузился, title «google.com» | `chrome-error://chromewebdata/` |
| youtube.com | загрузился, title «youtube.com» | `chrome-error://chromewebdata/` |

**Вывод.** Гипотеза ТЗ подтверждена: гость `<webview>` — отдельный WebContents со своим
main frame, `X-Frame-Options`/`frame-ancestors` на него не действуют, а iframe те же
адреса не пускает. Проверять `contentDocument` бесполезно — он `null` для любого
cross-origin; смотреть надо URL дочернего фрейма.

Побочно: у всех трёх в логе есть `did-fail-load` с `ERR_TIMED_OUT` — это подресурсы
(обработчик не фильтровал `isMainFrame`). В приложении фильтруем по main frame, иначе
заглушка «не загрузилось» будет вылезать на живой странице.

---

## 3. Персистентность сессии `persist:web` — ⚠️ проверено косвенно

Кука записана в `session.fromPartition('persist:web')`, приложение закрыто, запущено
заново — кука читается: `cnv_spike=spike-1790393794621`, домен `example.com`.
`storagePath` → `~/.config/<app>/Partitions/web`, то есть отдельное хранилище, изолированное
от сессии приложения.

**Честно:** реальный логин на github/google не выполнялся (нет учёток для теста).
Проверен механизм персистентности cookie-store между перезапусками, а не сквозной
сценарий «залогинился — перезапустил — всё ещё залогинен».

---

## 4. Оверлей, активация, `Esc` из гостя — ✅

| сценарий | хост | гость |
|---|---|---|
| колёсико над **неактивной** нодой | получил `wheel` (target `shield`), камера сдвинулась на −120 | 0 событий |
| двойной клик по ноде | нода стала активной | — |
| колёсико над **активной** нодой | 0 событий | 1 событие `wheel` |
| `Esc` внутри гостя (`sendInputEvent`) | пришёл `guest-escape`, активная нода снята | 0 событий `keydown` |

**Вывод.** Прозрачный оверлей поверх `<webview>` полностью забирает мышь и колёсико,
пока нода не активна. `before-input-event` на гостевом webContents ловит `Esc` и
`preventDefault()` не пускает его в страницу.

---

## 5. `capturePage()` и подмена live ↔ snapshot — ✅

- `capturePage()` гостя 480×320: **21 мс**, PNG data-URL ~15.8 КБ.
- Размер ноды до снимка, после подмены на `<img>` и после возврата живого webview —
  идентичен (482.098×322.098 CSS-px), прыжка нет.

---

## 6. Память и процессная модель — ✅, но не так, как ждёт ТЗ

Замер 1 (10 нод **одного** origin) и замер 2 (10 нод **разных** origin) дали одинаковую
картину: количество процессов не растёт.

| нод | процессов всего | RSS суммарно |
|---|---|---|
| 0 (baseline) | 3 | 366 МБ |
| 1 | 5 (+GPU, +Tab гостя) | 655 МБ |
| 5 | 5 | 674 МБ |
| 10 | 5 | 690 МБ |

Прямая проверка `webContents.getOSProcessId()` на 5 гостях с разными origin
(example.com, example.org, wikipedia.org, go.dev, nodejs.org): **у всех один и тот же
PID**. Разбивка процессов при 5 живых гостях: Browser 203 МБ, GPU 182 МБ, Utility 82 МБ,
Tab (окно приложения) 107 МБ, Tab (все гости) 97 МБ.

**Вывод.** Утверждение ТЗ «каждый `<webview>` — отдельный renderer-процесс» для
Electron 44 неверно: гости с общей partition живут в одном renderer-процессе, site
isolation между ними не работает. Дорог **первый** гость (+~290 МБ, в основном GPU-процесс),
каждый следующий — **3–5 МБ**.

Следствия (→ ADR-006): лимит живых webview остаётся, но мотивация другая — не память, а
CPU/раскладка/растеризация и изоляция отказов: зависший или упавший гость роняет всех
остальных. Порог «6 живых» из ТЗ сохраняем как настройку по умолчанию.

---

## 7. pdf.js с worker через `?url` в electron-vite — ✅

Отдельный мини-проект `spike/pdf` (electron-vite + pdfjs-dist 6.3.289), фикстура
`tests/fixtures/sample-320.pdf` — 320 страниц, 311 КБ, сгенерирована
`scripts/gen-pdf-fixture.mjs` через `webContents.printToPDF`.

```
WORKER_URL file://…/out/renderer/assets/pdf.worker.min-Dswkl-cV.mjs
OPEN pages=320 ms=52
TEXT7 marker-ok len=156
RENDER scale=0.5 306x396   ms=145
RENDER scale=1   612x792   ms=15
RENDER scale=2   1224x1584 ms=17
RENDER scale=3   1836x2376 ms=1017
LASTPAGE 320 612x792 ms=2
```

**Вывод.** `pdfjs-dist/build/pdf.worker.min.mjs?url` собирается в отдельный ассет и
грузится при CSP `worker-src 'self'`. Документ на 320 страниц открывается за 52 мс,
доступ к последней странице — 2 мс (ленивая загрузка работает). Перерендер той же
страницы под другой масштаб дешёвый (15–17 мс), кроме крупных растров (scale 3 → 1 с),
поэтому апскейл под zoom надо ограничивать и делать с debounce.

---

## 8. Wayland и X11 — ✅, способ из ТЗ устарел

Проверка настоящая: нативный Wayland-клиент не виден в `xlsclients`, XWayland-клиент виден.

| запуск | стартовал | виден в `xlsclients` | вывод |
|---|---|---|---|
| без флагов | да | нет | нативный Wayland |
| `--ozone-platform=x11` | да | да | XWayland |
| `--ozone-platform=wayland` | да | нет | нативный Wayland |

**`app.commandLine.appendSwitch('ozone-platform-hint', 'auto')` из ТЗ делать не надо.**
Переменная `ELECTRON_OZONE_PLATFORM_HINT` удалена в Electron 38, сам флаг
`--ozone-platform-hint` выпилен из Chromium 140 (дефолт `--ozone-platform` стал `auto`).
Начиная с 38 Electron сам поднимается нативным Wayland-клиентом при
`XDG_SESSION_TYPE=wayland`; форсить XWayland — `--ozone-platform=x11`. → ADR-005.

Известная мина: открытый баг electron#48859 — на Wayland событие `ready-to-show` иногда
не приходит. В `createMainWindow` поэтому стоит подстраховочный `setTimeout(…, 2500)`.

---

## 9. Что осталось непроверенным

- Реальный логин на сайте с сохранением между перезапусками (см. п. 3).
- Поведение `<webview>` под CSP приложения — в спайке CSP не выставлялся. Проверяем в Фазе 4.
- 60 fps на 500 нодах — нечего было мерить, целевой канвас появится в Фазе 9.

---

## Риск, который спайк подтвердил отдельно

Дока Electron 44 (`docs/api/webview-tag.md`) начинается с блока `## Warning`:
«We currently recommend to not use the `webview` tag», а туториал web-embeds добавляет
«We do not guarantee that the WebView API will remain available in future versions».
Формального deprecation и даты удаления нет, в breaking-changes 33→44 записей об
удалении тоже нет. Технически всё работает (пункты 1–5). Решение — ADR-004.
