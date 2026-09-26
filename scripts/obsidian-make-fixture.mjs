/**
 * Создаёт .canvas руками самого Obsidian (через его внутренний canvas API) и кладёт
 * результат в tests/fixtures/. Нужен для приёмки Фазы 3: «канвас, созданный в Obsidian,
 * открывается корректно».
 *
 * Запуск: node scripts/obsidian-make-fixture.mjs
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const PORT = 9334
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-obsidian-fx-'))
const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-obsidian-fxcfg-'))
const canvasName = 'fixture.canvas'

await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), '{}')
await fs.writeFile(path.join(vault, 'note.md'), '# Заметка\n\nТекст заметки.\n', 'utf8')
await fs.writeFile(path.join(vault, canvasName), '{"nodes":[],"edges":[]}\n', 'utf8')

const child = spawn(
  'obsidian',
  [`--remote-debugging-port=${PORT}`, '--no-sandbox', `--user-data-dir=${configDir}`],
  { stdio: 'ignore', detached: true }
)

let browser
try {
  for (let i = 0; i < 40 && !browser; i++) {
    await sleep(1000)
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    } catch {
      /* ещё не поднялся */
    }
  }
  if (!browser) throw new Error('не достучался до Obsidian по CDP')

  const context = browser.contexts()[0]
  let page = context.pages()[0]

  const isVaultPicker = await page.evaluate(() => !window.app)
  if (isVaultPicker) {
    await page.evaluate((v) => {
      window.require('electron').ipcRenderer.sendSync('vault-open', v, false)
    }, vault)
    await sleep(7000)
    const pages = context.pages()
    page = pages[pages.length - 1]
  }

  await page.evaluate(async (file) => {
    const f = window.app.vault.getAbstractFileByPath(file)
    await window.app.workspace.getLeaf(true).openFile(f)
  }, canvasName)
  await sleep(3500)

  const api = await page.evaluate(() => {
    const canvas = window.app.workspace.getLeaf(false)?.view?.canvas
    if (!canvas) return { ok: false }
    const proto = Object.getPrototypeOf(canvas)
    return {
      ok: true,
      methods: Object.getOwnPropertyNames(proto).filter((m) => /create|add|node|edge/i.test(m))
    }
  })
  console.log('методы canvas:', JSON.stringify(api))

  const built = await page.evaluate(async () => {
    const canvas = window.app.workspace.getLeaf(false).view.canvas
    const made = {}

    const text = canvas.createTextNode({
      pos: { x: -400, y: -200 },
      size: { width: 300, height: 160 },
      text: '# Заголовок\n\n- пункт\n- ещё пункт\n\n**жирный** и `код`',
      save: false,
      focus: false
    })
    made.text = text?.id

    const file = canvas.createFileNode({
      pos: { x: 0, y: -200 },
      size: { width: 320, height: 200 },
      file: window.app.vault.getAbstractFileByPath('note.md'),
      save: false,
      focus: false
    })
    made.file = file?.id

    const link = canvas.createLinkNode({
      pos: { x: 400, y: -200 },
      size: { width: 420, height: 260 },
      url: 'https://jsoncanvas.org',
      save: false,
      focus: false
    })
    made.link = link?.id

    const group = canvas.createGroupNode({
      pos: { x: -440, y: 160 },
      size: { width: 800, height: 320 },
      label: 'Группа',
      save: false,
      focus: false
    })
    made.group = group?.id

    if (text?.setColor) text.setColor('4')

    const data = canvas.getData()
    data.edges = [
      {
        id: 'e0000000000000a1',
        fromNode: made.text,
        fromSide: 'right',
        toNode: made.link,
        toSide: 'left',
        label: 'ссылается',
        color: '2'
      },
      {
        id: 'e0000000000000a2',
        fromNode: made.file,
        fromSide: 'bottom',
        toNode: made.group,
        toSide: 'top',
        toEnd: 'none'
      }
    ]
    canvas.setData(data)
    canvas.requestSave()
    await new Promise((r) => setTimeout(r, 2500))
    return { made, nodes: canvas.nodes.size, edges: canvas.edges.size }
  })
  console.log('создано:', JSON.stringify(built))

  await sleep(3000)
  const produced = await fs.readFile(path.join(vault, canvasName), 'utf8')
  console.log('\n=== ФАЙЛ ОТ OBSIDIAN ===')
  console.log(produced)

  const parsed = JSON.parse(produced)
  if ((parsed.nodes?.length ?? 0) >= 3) {
    const out = path.resolve('tests/fixtures/obsidian-authored.canvas')
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, produced, 'utf8')
    console.log('записал', out)
  } else {
    console.log('нод мало, фикстуру не пишу')
  }
} finally {
  try {
    await browser?.close()
  } catch {
    /* пусто */
  }
  try {
    process.kill(-child.pid)
  } catch {
    /* пусто */
  }
}
