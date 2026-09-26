/**
 * Скриншоты для README. Всегда со своим --user-data-dir (ADR-021): иначе запуск
 * перезапишет настройки и путь к канвасу у живого пользователя.
 *
 * node scripts/dev/shots.mjs   (требует npm run build)
 */
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const root = process.cwd()
const out = path.join(root, 'docs/img')
await fs.mkdir(out, { recursive: true })

const shot = async (name, { nodes, edges = [], prepare, clip, settings = {}, wait = 2500 }) => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-shot-'))
  const ud = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-shot-ud-'))
  for (const asset of ['build/icon.png', 'tests/fixtures/sample-320.pdf']) {
    await fs.copyFile(path.join(root, asset), path.join(ws, path.basename(asset)))
  }
  const file = path.join(ws, 'scratchpad.canvas')
  await fs.writeFile(file, JSON.stringify({ nodes, edges }))

  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js'), `--user-data-dir=${ud}`, file],
    cwd: root
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="viewport"]')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  if (Object.keys(settings).length > 0) {
    await page.evaluate((s) => window.api.settings.patch(s), settings)
  }
  await page.waitForTimeout(1200)
  await page.locator('[data-testid="viewport"]').click({ position: { x: 30, y: 780 } })
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(wait)
  if (prepare) await prepare(page)

  await page.screenshot({ path: path.join(out, name), ...(clip ? { clip } : {}) })
  await app.close()
  await fs.rm(ws, { recursive: true, force: true })
  await fs.rm(ud, { recursive: true, force: true })
  console.log(name)
}

const card = (id, x, y, width, height, text, color) => ({
  id,
  type: 'text',
  text,
  x,
  y,
  width,
  height,
  ...(color ? { color } : {})
})

await shot('hero.png', {
  wait: 9000,
  nodes: [
    { id: 'g1', type: 'group', label: 'Заметки', x: -760, y: -360, width: 560, height: 700 },
    card(
      'n1',
      -740,
      -340,
      480,
      280,
      '# Скретчпад\n\nОдин файл, один холст.\nОткрыл, поработал, закрыл.\n\n- markdown-карточки\n- картинки и PDF\n- **живые** веб-страницы\n- связи, группы, выравнивание',
      '5'
    ),
    { id: 'n4', type: 'file', file: 'icon.png', x: -740, y: 0, width: 260, height: 260 },
    { id: 'n2', type: 'link', url: 'https://vitejs.dev', x: -140, y: -360, width: 700, height: 460 },
    { id: 'n3', type: 'file', file: 'sample-320.pdf', x: 620, y: -360, width: 440, height: 580 },
    card('n5', -140, 160, 380, 120, 'Связи тянутся от точек на краях ноды.', '3')
  ],
  edges: [
    { id: 'e1', fromNode: 'n1', fromSide: 'right', toNode: 'n2', toSide: 'left', label: 'смотри', color: '5' },
    { id: 'e2', fromNode: 'n5', fromSide: 'right', toNode: 'n3', toSide: 'left' }
  ]
})

await shot('web.png', {
  wait: 14000,
  nodes: [
    'https://vitejs.dev',
    'https://go.dev',
    'https://nodejs.org',
    'https://www.rust-lang.org',
    'https://example.com',
    'https://www.kernel.org'
  ].map((url, i) => ({
    id: `w${i}`,
    type: 'link',
    url,
    x: (i % 3) * 700,
    y: Math.floor(i / 3) * 560,
    width: 640,
    height: 500
  }))
})

await shot('pdf.png', {
  wait: 3000,
  nodes: [{ id: 'p1', type: 'file', file: 'sample-320.pdf', x: 0, y: 0, width: 560, height: 740 }],
  prepare: async (page) => {
    await page.locator('[data-node-kind="pdf"]').dblclick({ position: { x: 200, y: 300 } })
    await page.waitForSelector('.pdf-page__text span', { timeout: 20000 })
    await page.locator('.node-pdf__bar button[title="Следующая"]').click()
    await page.waitForTimeout(2500)
  }
})

await shot('settings.png', {
  wait: 800,
  nodes: [card('n1', 0, 0, 300, 120, 'фон', '4')],
  prepare: async (page) => {
    await page.keyboard.press('Control+,')
    await page.waitForSelector('[data-testid="settings"]')
    await page.waitForTimeout(400)
  }
})

await shot('snapping.png', {
  wait: 800,
  nodes: [
    card('a', 0, 0, 260, 140, '## Смарт-направляющие\n\nКрая и центры соседей,\nпорог в экранных пикселях.', '5'),
    card('b', 0, 300, 200, 200, 'тянется', '2'),
    card('c', 520, 120, 240, 160, 'сосед', '3')
  ],
  prepare: async (page) => {
    const box = await page.locator('[data-node-id="b"]').boundingBox()
    await page.mouse.move(box.x + 30, box.y + 14)
    await page.mouse.down()
    await page.mouse.move(box.x + 34, box.y + 14, { steps: 6 })
    await page.waitForTimeout(300)
  }
})

console.log('готово:', out)
process.exit(0)
