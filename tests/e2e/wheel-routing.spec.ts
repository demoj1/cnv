import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cameraState, launchApp, type Harness } from './helpers'

/**
 * Кому достаётся колесо. Правило ровно одно, и оно должно держаться во всех состояниях:
 *
 *   колесо принадлежит ноде, если та забрала мышь себе (активна и умеет её принимать),
 *   во всех остальных случаях — холсту.
 *
 * Случай «активна, но прокручивать нечего» — тот самый, на котором это ломалось: xterm
 * и PDF съедают колесо только пока есть куда скроллить, дальше событие всплывает.
 *
 * Ввод настоящий, через X11: синтетическое колесо Playwright идёт мимо реального пути и
 * уже дважды позволяло объявить рабочим то, что не работало.
 */

let h: Harness

const xdotoolReady = (): boolean => {
  if (!process.env.DISPLAY) return false
  try {
    execFileSync('xdotool', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test.skip(!xdotoolReady(), 'нужен X-дисплей и xdotool: запускать под xvfb-run')

const xdo = (...args: string[]): void => {
  execFileSync('xdotool', args, { env: process.env })
}

const NODES = {
  text: 'text000000000001',
  image: 'img0000000000001',
  group: 'grp0000000000001',
  pdf: 'pdf0000000000001',
  terminal: null as string | null
}

test.beforeAll(async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'cnv-wheel-'))
  await copyFile('tests/fixtures/pixel.png', path.join(ws, 'pixel.png'))
  await copyFile('tests/fixtures/sample-320.pdf', path.join(ws, 'sample.pdf'))

  h = await launchApp({
    workspaceDir: ws,
    canvasContent: JSON.stringify({
      nodes: [
        {
          id: NODES.text,
          type: 'text',
          text: Array.from({ length: 80 }, (_, i) => `строка ${i}`).join('\n'),
          x: 0,
          y: 0,
          width: 360,
          height: 260
        },
        { id: NODES.image, type: 'file', file: 'pixel.png', x: 420, y: 0, width: 360, height: 260 },
        { id: NODES.group, type: 'group', label: 'группа', x: 840, y: 0, width: 360, height: 260 },
        { id: NODES.pdf, type: 'file', file: 'sample.pdf', x: 0, y: 320, width: 360, height: 400 }
      ],
      edges: []
    })
  })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 20, y: 740 } })
  await h.page.keyboard.press('Control+0')
  await h.page.waitForTimeout(800)

  const win = execFileSync('xdotool', ['search', '--name', 'cnv'], { env: process.env })
    .toString()
    .trim()
    .split('\n')
    .pop()
  xdo('windowraise', String(win))
})

test.afterAll(async () => {
  await h?.close()
})

/** Экранные координаты центра ноды: xdotool живёт в координатах экрана, рамка — окна. */
async function centerOf(
  selector: string
): Promise<{ screen: { x: number; y: number }; page: { x: number; y: number } }> {
  const box = await h.page.locator(selector).boundingBox()
  if (!box) throw new Error(`не вижу ${selector}`)
  const content = await h.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('нет окна')
    return win.getContentBounds()
  })
  const page = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  return { page, screen: { x: Math.round(content.x + page.x), y: Math.round(content.y + page.y) } }
}

/** Крутим колесо над точкой и говорим, поехал ли холст. */
async function wheelAt(
  selector: string,
  options: { ctrl?: boolean; ticks?: number; direction?: 'up' | 'down' } = {}
): Promise<{ cameraMoved: boolean; overTarget: boolean }> {
  const { screen, page } = await centerOf(selector)
  xdo('mousemove', '--sync', String(screen.x), String(screen.y))
  await h.page.waitForTimeout(120)

  // Курсор обязан стоять над тем, что проверяем, иначе тест меряет пустой холст.
  const overTarget = await h.page.evaluate(
    (p) => {
      const el = document.elementFromPoint(p.x, p.y)
      return Boolean(el?.closest(p.selector))
    },
    { ...page, selector }
  )

  const before = await cameraState(h.page)
  if (options.ctrl) xdo('keydown', 'ctrl')
  for (let i = 0; i < (options.ticks ?? 3); i++) xdo('click', options.direction === 'up' ? '4' : '5')
  await h.page.waitForTimeout(350)
  if (options.ctrl) xdo('keyup', 'ctrl')
  await h.page.waitForTimeout(120)

  const after = await cameraState(h.page)
  return {
    overTarget,
    cameraMoved: after.x !== before.x || after.y !== before.y || after.zoom !== before.zoom
  }
}

const activate = async (selector: string): Promise<void> => {
  await h.page.locator(selector).dblclick({ position: { x: 60, y: 60 } })
  await h.page.waitForTimeout(400)
}

const deactivate = async (): Promise<void> => {
  await h.page.keyboard.press('Escape')
  await h.page.waitForTimeout(200)
}

/**
 * Вид сбрасываем перед каждым замером: любое движение холста уносит ноду из-под
 * курсора, и следующий замер крутил бы колесо мимо неё. Годится только когда ни одна
 * нода не активна — иначе `Shift+1` уедет в саму ноду.
 */
async function resetView(): Promise<void> {
  await deactivate()
  await h.page.keyboard.press('Shift+1')
  await h.page.waitForTimeout(400)
}

test.beforeEach(resetView)

const ownsInput = (selector: string): Promise<number> =>
  h.page.locator(`${selector}[data-owns-input="true"]`).count()

test.describe('колесо над неактивными нодами достаётся холсту', () => {
  for (const [name, id] of [
    ['карточка', NODES.text],
    ['картинка', NODES.image],
    ['группа', NODES.group],
    ['PDF', NODES.pdf]
  ] as const) {
    test(`${name}: и панорама, и зум`, async () => {
      const pan = await wheelAt(`[data-node-id="${id}"]`)
      expect(pan.overTarget, 'курсор должен стоять над нодой').toBe(true)
      expect(pan.cameraMoved, 'холст обязан панорамироваться').toBe(true)

      // Панорама унесла ноду из-под курсора — возвращаем вид, иначе замеряли бы пустоту.
      await resetView()
      // Зумим внутрь: после «вписать всё» наружу упираемся в минимальный масштаб, и
      // неподвижный холст означал бы предел, а не поломку.
      const zoom = await wheelAt(`[data-node-id="${id}"]`, { ctrl: true, direction: 'up' })
      expect(zoom.overTarget, 'курсор должен стоять над нодой').toBe(true)
      expect(zoom.cameraMoved, 'холст обязан зумиться').toBe(true)
    })
  }
})

test.describe('нода забирает мышь только если умеет её принимать', () => {
  for (const [name, id] of [
    ['картинка', NODES.image],
    ['группа', NODES.group]
  ] as const) {
    test(`${name} не становится активной по двойному клику`, async () => {
      await activate(`[data-node-id="${id}"]`)
      // Активной она не становится вовсе: «активная картинка» — состояние, которое
      // ничем не обрабатывается, и держать его значит копить такие же баги.
      expect(await h.page.locator('.node--active').count(), 'активных нод быть не должно').toBe(0)
      expect(await ownsInput(`[data-node-id="${id}"]`)).toBe(0)

      // И колесо над ней по-прежнему работает: иначе холст замирал бы над картинкой.
      const moved = await wheelAt(`[data-node-id="${id}"]`)
      expect(moved.cameraMoved, 'холст не должен замирать над неинтерактивной нодой').toBe(true)
    })
  }
})

test.describe('активная нода держит колесо', () => {
  test('карточка в режиме правки', async () => {
    await activate(`[data-node-id="${NODES.text}"]`)
    expect(await ownsInput(`[data-node-id="${NODES.text}"]`)).toBe(1)

    const down = await wheelAt(`[data-node-id="${NODES.text}"]`)
    expect(down.overTarget).toBe(true)
    expect(down.cameraMoved, 'холст не должен ехать под редактором').toBe(false)

    // Доскроллили до конца — событию больше некуда деваться, и вот тут оно всплывало.
    const past = await wheelAt(`[data-node-id="${NODES.text}"]`, { ticks: 30 })
    expect(past.cameraMoved, 'дошли до конца текста — холст всё равно стоит').toBe(false)

    const zoom = await wheelAt(`[data-node-id="${NODES.text}"]`, { ctrl: true })
    expect(zoom.cameraMoved, 'Ctrl+колесо тоже принадлежит ноде').toBe(false)
  })

  test('PDF: и в начале, и после конца документа', async () => {
    await activate(`[data-node-id="${NODES.pdf}"]`)
    expect(await ownsInput(`[data-node-id="${NODES.pdf}"]`)).toBe(1)

    expect((await wheelAt(`[data-node-id="${NODES.pdf}"]`)).cameraMoved).toBe(false)
    expect((await wheelAt(`[data-node-id="${NODES.pdf}"]`, { ticks: 40 })).cameraMoved).toBe(false)
    expect((await wheelAt(`[data-node-id="${NODES.pdf}"]`, { direction: 'up', ticks: 40 })).cameraMoved).toBe(
      false
    )
    expect((await wheelAt(`[data-node-id="${NODES.pdf}"]`, { ctrl: true })).cameraMoved).toBe(false)
  })

  test('терминал: пустой скроллбэк — самый частый случай', async () => {
    await h.page.keyboard.press('Control+Shift+T')
    await expect.poll(() => h.page.locator('[data-node-kind="terminal"]').count(), { timeout: 15000 }).toBe(1)
    await activate('[data-node-kind="terminal"]')
    expect(await ownsInput('[data-node-kind="terminal"]')).toBe(1)

    expect((await wheelAt('[data-node-kind="terminal"]')).cameraMoved).toBe(false)
    expect((await wheelAt('[data-node-kind="terminal"]', { direction: 'up', ticks: 20 })).cameraMoved).toBe(
      false
    )
    expect((await wheelAt('[data-node-kind="terminal"]', { ctrl: true })).cameraMoved).toBe(false)
  })
})

test.describe('выход из ноды возвращает колесо холсту', () => {
  test('Esc и клик по пустому месту', async () => {
    await activate(`[data-node-id="${NODES.text}"]`)
    expect((await wheelAt(`[data-node-id="${NODES.text}"]`)).cameraMoved).toBe(false)

    await h.page.keyboard.press('Escape')
    await h.page.waitForTimeout(300)
    expect(await ownsInput(`[data-node-id="${NODES.text}"]`)).toBe(0)
    expect((await wheelAt(`[data-node-id="${NODES.text}"]`)).cameraMoved).toBe(true)
  })

  test('нода активна, но курсор мимо неё — холст живой', async () => {
    await activate(`[data-node-id="${NODES.text}"]`)
    // Курсор над соседней неактивной нодой: активность одной ноды не глушит весь холст.
    const moved = await wheelAt(`[data-node-id="${NODES.image}"]`)
    expect(moved.overTarget).toBe(true)
    expect(moved.cameraMoved).toBe(true)
  })
})
