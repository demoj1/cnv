/**
 * Тестовый канвас для замера производительности: 500 нод, из них несколько живых
 * веб-страниц (ТЗ 3.5). Пишет .canvas в указанную папку-workspace.
 *
 * node scripts/gen-bench-canvas.mjs [папка] [сколько нод] [сколько веб-нод]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const dir = path.resolve(args[0] ?? 'bench-workspace')
const total = Number(args[1] ?? 500)
const webCount = Number(args[2] ?? 6)

const WEB_URLS = [
  'https://example.com',
  'https://example.org',
  'https://www.iana.org',
  'https://go.dev',
  'https://nodejs.org',
  'https://vitejs.dev'
]

const LOREM = [
  'Заголовок карточки',
  'The quick brown fox jumps over the lazy dog.',
  'Съешь ещё этих мягких французских булок.',
  '- пункт списка',
  '- ещё пункт',
  '`немного кода` и **жирный текст**'
]

const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16)

const columns = Math.ceil(Math.sqrt(total))
const nodes = []
const edges = []

for (let i = 0; i < total; i++) {
  const col = i % columns
  const row = Math.floor(i / columns)
  const x = col * 420
  const y = row * 320
  if (i < webCount) {
    nodes.push({
      id: id(),
      type: 'link',
      url: WEB_URLS[i % WEB_URLS.length],
      x,
      y,
      width: 380,
      height: 280
    })
    continue
  }
  const lines = LOREM.slice(0, 2 + (i % 4)).join('\n')
  nodes.push({
    id: id(),
    type: 'text',
    text: `# Нода ${i + 1}\n\n${lines}`,
    x,
    y,
    width: 380,
    height: 280,
    ...(i % 7 === 0 ? { color: String((i % 6) + 1) } : {})
  })
}

for (let i = webCount; i + 1 < nodes.length; i += 9) {
  edges.push({
    id: id(),
    fromNode: nodes[i].id,
    fromSide: 'right',
    toNode: nodes[i + 1].id,
    toSide: 'left'
  })
}

const serialize = (doc) => {
  const block = (key, list) =>
    list.length === 0
      ? `\t"${key}":[]`
      : `\t"${key}":[\n${list.map((x) => `\t\t${JSON.stringify(x)}`).join(',\n')}\n\t]`
  return `{\n${block('nodes', doc.nodes)},\n${block('edges', doc.edges)}\n}`
}

await fs.mkdir(dir, { recursive: true })
const file = path.join(dir, `bench-${total}.canvas`)
await fs.writeFile(file, serialize({ nodes, edges }), 'utf8')
console.log(`${file}: ${nodes.length} нод (${webCount} веб), ${edges.length} рёбер`)
