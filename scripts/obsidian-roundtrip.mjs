/**
 * Проверяет, переживают ли посторонние поля в .canvas открытие и пересохранение
 * настоящим Obsidian. Obsidian — Electron, поэтому поднимаем его с
 * --remote-debugging-port и цепляемся к нему через CDP.
 *
 * Запуск: node scripts/obsidian-roundtrip.mjs
 */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-obsidian-vault-'))
const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cnv-obsidian-cfg-'))
const canvasName = 'roundtrip.canvas'
const canvasPath = path.join(vault, canvasName)

const original = {
  nodes: [
    {
      id: '0123456789abcdef',
      type: 'text',
      text: 'привет',
      x: -120,
      y: 40,
      width: 260,
      height: 120,
      color: '4',
      'x-cnv': { cameraNote: 'не трогай меня', page: 7 },
      totallyUnknownField: [1, 2, 3]
    },
    {
      id: 'fedcba9876543210',
      type: 'link',
      url: 'https://example.com',
      x: 200,
      y: 40,
      width: 400,
      height: 300
    }
  ],
  edges: [
    {
      id: 'aaaabbbbccccdddd',
      fromNode: '0123456789abcdef',
      fromSide: 'right',
      toNode: 'fedcba9876543210',
      toSide: 'left',
      label: 'связь',
      customEdgeField: 'сохранись'
    }
  ],
  rootLevelJunk: { hello: 'world' }
}

await fs.mkdir(path.join(vault, '.obsidian'), { recursive: true })
await fs.writeFile(path.join(vault, '.obsidian', 'app.json'), '{}')
await fs.writeFile(canvasPath, JSON.stringify(original, null, 2) + '\n', 'utf8')

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
  for (let i = 0; i < 30 && !page; i++) {
    await sleep(500)
    page = context.pages()[0]
  }
  console.log('подключился, страниц:', context.pages().length, 'url:', page.url())

  // Открываем vault и канвас через внутренний API Obsidian.
  const opened = await page.evaluate(
    async ([vaultPath, file]) => {
      const w = window
      if (!w.app) {
        if (w.electron?.remote?.app) {
          w.require('electron').ipcRenderer.sendSync('vault-open', vaultPath, false)
          return 'sent-vault-open'
        }
        return 'no-app'
      }
      const f = w.app.vault.getAbstractFileByPath(file)
      if (!f) return 'no-file'
      await w.app.workspace.getLeaf(true).openFile(f)
      return 'opened'
    },
    [vault, canvasName]
  )
  console.log('открытие:', opened)

  if (opened === 'sent-vault-open') {
    await sleep(6000)
    const pages = context.pages()
    page = pages[pages.length - 1]
    await page.evaluate(async (file) => {
      const f = window.app.vault.getAbstractFileByPath(file)
      if (f) await window.app.workspace.getLeaf(true).openFile(f)
    }, canvasName)
  }

  await sleep(4000)

  // Двигаем ноду средствами самого Obsidian и заставляем его сохранить файл.
  const moved = await page.evaluate(async () => {
    const view = window.app.workspace.getActiveViewOfType?.(
      window.app.viewRegistry?.typeByExtension?.canvas
        ? Object.getPrototypeOf(window.app.workspace.getLeaf(false).view).constructor
        : Object
    )
    const leaf = window.app.workspace.getLeaf(false)
    const canvas = leaf?.view?.canvas
    if (!canvas) return { ok: false, why: 'нет canvas во view', viewType: leaf?.view?.getViewType?.() }
    const node = [...canvas.nodes.values()][0]
    node.moveAndResize({ x: node.x + 37, y: node.y + 11, width: node.width, height: node.height })
    canvas.requestSave()
    await new Promise((r) => setTimeout(r, 2500))
    return { ok: true, viewType: leaf.view.getViewType(), nodes: canvas.nodes.size, hasView: !!view }
  })
  console.log('сдвиг:', JSON.stringify(moved))

  await sleep(3000)
  const after = JSON.parse(await fs.readFile(canvasPath, 'utf8'))

  const node = after.nodes?.find((n) => n.id === '0123456789abcdef')
  const edge = after.edges?.[0]
  const report = {
    'x-cnv сохранился': !!node?.['x-cnv'],
    'x-cnv значение': node?.['x-cnv'],
    'totallyUnknownField сохранился': !!node?.totallyUnknownField,
    'customEdgeField сохранился': edge?.customEdgeField,
    'rootLevelJunk сохранился': after.rootLevelJunk,
    'координаты изменились': node ? { x: node.x, y: node.y } : null,
    'файл переписан': JSON.stringify(after) !== JSON.stringify(original)
  }
  console.log('\n=== РЕЗУЛЬТАТ ===')
  console.log(JSON.stringify(report, null, 2))
  console.log('\n=== ФАЙЛ ПОСЛЕ ===')
  console.log(JSON.stringify(after, null, 2).slice(0, 2000))
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
  console.log('\nvault:', vault)
}
