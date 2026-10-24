import { expect, test } from '@playwright/test'
import { launchApp, type Harness } from './helpers'

/**
 * В Linux средняя кнопка вставляет последнее выделенное (PRIMARY). На холсте средняя
 * кнопка — это панорама, и каждый сдвиг вида над активным терминалом вклеивал выделение
 * в его ввод: у агента в промпт подмешивался чужой текст.
 */

let h: Harness

test.beforeAll(async () => {
  h = await launchApp({ canvasContent: JSON.stringify({ nodes: [], edges: [] }) })
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 600, y: 700 } })
})
test.afterAll(async () => {
  await h.close()
})

const screenText = (): Promise<string> => h.page.locator('[data-testid="terminal-screen"]').innerText()

test('средняя кнопка над активным терминалом не вставляет выделение', async () => {
  test.skip(process.platform !== 'linux', 'PRIMARY-выделение есть только в Linux')
  await h.page.keyboard.press('Control+Shift+T')
  await expect.poll(() => h.page.locator('[data-node-kind="terminal"]').count(), { timeout: 15000 }).toBe(1)
  await expect.poll(screenText, { timeout: 20000 }).not.toBe('')
  await h.page.locator('[data-node-kind="terminal"]').dblclick({ position: { x: 200, y: 200 } })
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(0)

  // Второй аргумент — буфер PRIMARY; в типах Playwright для Electron его нет.
  await h.app.evaluate(({ clipboard }) =>
    (clipboard.writeText as (text: string, type: string) => void)('PRIMARY_LEAK_MARK', 'selection')
  )
  const box = await h.page.getByTestId('terminal-screen').boundingBox()
  for (let i = 0; i < 3; i++) {
    await h.page.mouse.move(box!.x + 200, box!.y + 150)
    await h.page.mouse.down({ button: 'middle' })
    await h.page.mouse.move(box!.x + 230, box!.y + 170, { steps: 4 })
    await h.page.mouse.up({ button: 'middle' })
  }
  await h.page.keyboard.type('echo TYPED_OK')
  await expect.poll(screenText, { timeout: 5000 }).toContain('TYPED_OK')
  expect(await screenText()).not.toContain('PRIMARY_LEAK_MARK')
})

/**
 * Терминал масштабируется вместе с холстом, а xterm считает клетки без масштаба: при
 * zoom ≠ 1 двойной клик выделял не то слово. Проверяем по геометрии — где слово на
 * экране и где xterm нарисовал выделение.
 */
test('при zoom ≠ 1 двойной клик выделяет слово под курсором', async () => {
  await h.page.keyboard.press('Enter')
  await h.page.keyboard.type('echo aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ZOOMWORD tail')
  await h.page.keyboard.press('Enter')
  await expect.poll(screenText).toContain('ZOOMWORD tail\n')
  await h.page.keyboard.press('Escape')
  // «+» в HUD — zoomIn к центру экрана: терминал стоит по центру и остаётся в кадре.
  await h.page.locator('.hud button').last().click()
  await h.page.waitForTimeout(400)
  await h.page.locator('[data-node-kind="terminal"]').dblclick({ position: { x: 300, y: 300 } })
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(0)

  // Где на экране слово: строка вывода (последняя с маркером) и колонка в ней.
  const target = await h.page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen') as HTMLElement
    const rows = [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '')
    const row = rows.findLastIndex((t) => t.startsWith('aaaa') || t.includes(' ZOOMWORD tail'))
    const col = rows[row]!.indexOf('ZOOMWORD')
    const rect = screen.getBoundingClientRect()
    const scale = rect.width / screen.offsetWidth
    // Ширину клетки xterm меряет строкой из одинаковых знаков — берём ту же мерку, без масштаба.
    const measure = document.querySelector('.xterm-char-measure-element') as HTMLElement
    const cellW = measure.offsetWidth / measure.textContent!.length
    const cellH = screen.offsetHeight / rows.length
    return {
      scale,
      col,
      cellW,
      x: rect.left + (col + 3) * cellW * scale,
      y: rect.top + (row + 0.5) * cellH * scale
    }
  })
  expect(target.scale).toBeGreaterThan(1.1)
  // Пауза, иначе этот двойной клик сложится с активирующим в тройной — выделение строки.
  await h.page.waitForTimeout(800)
  await h.page.mouse.dblclick(target.x, target.y)
  const id = await h.page.locator('[data-node-kind="terminal"]').getAttribute('data-node-id')
  const selected = await h.page.evaluate(
    (nodeId) =>
      (window as unknown as { __cnvTerminalSelection(id: string): string | null }).__cnvTerminalSelection(
        nodeId
      ),
    id!
  )
  expect(selected).toBe('ZOOMWORD')
})

test('у простого терминала «+ роль» нет; заданная роль видна и правится кликом', async () => {
  // Клик по пустому холсту снимает активность с терминала.
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 150, y: 120 } })
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(1)
  const role = h.page.locator('[data-node-kind="terminal"] [data-testid="terminal-role"]')
  await expect(role).toHaveCount(0)
  // Роль из меню — и она в шапке.
  await h.page.getByTestId('terminal-shield').click({ button: 'right' })
  await h.page.locator('[data-command="node.role"]').click()
  const prompt = h.page.getByTestId('text-prompt')
  await expect(prompt).toBeVisible()
  await prompt.locator('input').fill('ревьюер')
  await prompt.locator('input').press('Enter')
  await expect(role).toHaveText('ревьюер')
  await role.click()
  await expect(prompt).toBeVisible()
  await prompt.locator('input').press('Escape')
  // Клик по кнопке не тащит ноду и не открывает терминал.
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(1)
})

test('клик по имени в шапке — переименование', async () => {
  const name = h.page.locator('[data-node-kind="terminal"] [data-testid="terminal-name"]')
  await name.click()
  const prompt = h.page.getByTestId('text-prompt')
  await expect(prompt).toBeVisible()
  await prompt.locator('input').fill('Новый Тест')
  await prompt.locator('input').press('Enter')
  await expect(name).toHaveText('Новый Тест')
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(1)
})

test('цвет терминала — точкой в шапке, палитра под ней', async () => {
  const node = h.page.locator('[data-node-kind="terminal"]')
  await node.getByTestId('header-color').click()
  await node.locator('[data-testid="node-colors"] [data-color="5"]').click()
  await expect(node).toHaveClass(/node--color-5/)
  // Клик мимо закрывает палитру.
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 150, y: 120 } })
  await expect(node.getByTestId('node-colors')).toHaveCount(0)
})

test('Shift+Enter в терминале — перевод строки (\\n), а не Enter (\\r)', async () => {
  const node = h.page.locator('[data-node-kind="terminal"]')
  await node.dblclick({ position: { x: 300, y: 300 } })
  await expect(h.page.getByTestId('terminal-shield')).toHaveCount(0)
  // Строка ввода могла остаться от прошлых тестов — сбрасываем.
  await h.page.keyboard.press('Control+c')
  await h.page.waitForTimeout(300)
  // Сырой режим: программа видит ровно тот байт, что пришёл с клавиши.
  await h.page.keyboard.type(
    `python3 -c "import sys,tty; tty.setraw(0); b=sys.stdin.read(1); tty.setcbreak(0); print('GOT', repr(b))"`
  )
  await h.page.keyboard.press('Enter')
  await h.page.waitForTimeout(800)
  await h.page.keyboard.press('Shift+Enter')
  await expect.poll(screenText, { timeout: 5000 }).toContain(`GOT '\\n'`)
})
