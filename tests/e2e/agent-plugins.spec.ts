import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, type Harness } from './helpers'

/**
 * Плагины агентов: свой `.mjs` из папки ложится рядом со встроенными, и cnv гоняет его по
 * контракту — start, getSession (id сохраняется в .canvas), после перезапуска — resume.
 * Агенты в тесте — `echo`: проверяем командные строки, а не живые модели.
 */

let h: Harness
let userData: string
let workspace: string

const FAKE = `
export default {
  id: 'fake',
  label: 'Фейковый агент',
  command: 'echo',
  start: (c) => [c.command, 'FAKE_START', c.quote(c.prompt ?? 'без задания')].join(' '),
  resume: (c) => [c.command, 'FAKE_RESUME', c.sessionId].join(' '),
  getSession: (q) => 'fake-session-' + q.nodeId.slice(0, 4),
  hasSession: () => true,
  listSessions: () => [
    { id: 'old-session-aaa', updatedAt: Date.now() - 3600000, title: 'Уголки для стойки' },
    { id: 'old-session-bbb', updatedAt: Date.now() - 86400000, title: 'Ozon телефоны' }
  ]
}
`

const launch = (): Promise<Harness> =>
  launchApp({ userDataDir: userData, workspaceDir: workspace, canvasContent: undefined })

const canvasJson = async (): Promise<{
  nodes: { id: string; 'x-cnv'?: { terminal?: { agent?: object } } }[]
}> => {
  await h.page.evaluate(() => (window as unknown as { __cnvFlush(): Promise<void> }).__cnvFlush())
  return JSON.parse(await readFile(h.canvasFile, 'utf8'))
}

const screen = (id: string): Promise<string> =>
  h.page.locator(`[data-node-id="${id}"] [data-testid="terminal-screen"]`).innerText()

test.beforeAll(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'cnv-ud-agents-'))
  workspace = await mkdtemp(path.join(tmpdir(), 'cnv-ws-agents-'))
  await mkdir(path.join(userData, 'agents'), { recursive: true })
  await writeFile(path.join(userData, 'agents', 'fake.mjs'), FAKE)
  await writeFile(path.join(userData, 'agents', 'broken.mjs'), `export default { id: 'broken' }`)
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      settings: {
        agents: { default: 'fake', commands: { codex: 'echo' } },
        terminal: { shell: '/bin/sh' }
      },
      canvasPath: null
    })
  )
  await writeFile(path.join(workspace, 'scratchpad.canvas'), JSON.stringify({ nodes: [], edges: [] }))
  h = await launch()
})

test.afterAll(async () => {
  await h?.close()
  await rm(userData, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

test('настройки показывают встроенных и своих агентов, битый плагин — с причиной', async () => {
  await h.page.keyboard.press('Control+,')
  const section = h.page.getByTestId('agents-settings')
  await expect(section.locator('[data-agent-plugin]')).toHaveCount(4)
  await expect(section.locator('[data-agent-plugin="fake"]')).toContainText('свой плагин')
  await expect(section.locator('[data-agent-plugin="codex"]')).toContainText('встроенный')
  await expect(h.page.locator('[data-setting="agentsDefault"]')).toHaveValue('fake')
  await expect(h.page.getByTestId('agent-plugin-error')).toContainText('broken.mjs')
  await h.page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(h.page.getByTestId('settings')).toHaveCount(0)
})

let fakeId = ''

test('Ctrl+Shift+A — агент по умолчанию: start, сессия записана в .canvas', async () => {
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 600, y: 700 } })
  await h.page.keyboard.press('Control+Shift+A')
  const node = h.page.locator('[data-node-kind="terminal"]')
  await expect(node).toHaveCount(1, { timeout: 15000 })
  fakeId = (await node.getAttribute('data-node-id'))!
  await expect(node.getByTestId('terminal-agent')).toHaveText('Фейковый агент')
  await expect.poll(() => screen(fakeId), { timeout: 20000 }).toContain('FAKE_START без задания')
  await expect
    .poll(async () => (await canvasJson()).nodes.find((n) => n.id === fakeId)?.['x-cnv']?.terminal?.agent)
    .toEqual({ plugin: 'fake', sessionId: `fake-session-${fakeId.slice(0, 4)}` })
})

test('после перезапуска — resume той же сессии', async () => {
  await h.app.close()
  h = await launch()
  await expect
    .poll(() => screen(fakeId), { timeout: 20000 })
    .toContain(`FAKE_RESUME fake-session-${fakeId.slice(0, 4)}`)
})

test('правый клик по ✦ — список агентов; Codex запускается с холстом по HTTP', async () => {
  await h.page.locator('.create-bar__item[data-kind="agent"]').click({ button: 'right' })
  const list = h.page.getByTestId('create-agents')
  await expect(list.locator('[data-agent]')).toHaveCount(4)
  await list.locator('[data-agent="codex"]').click()
  await expect(h.page.getByTestId('create-agents')).toHaveCount(0)
  const codex = h.page.locator('[data-node-kind="terminal"]', { hasText: 'Codex' })
  await expect(codex).toHaveCount(1, { timeout: 15000 })
  const id = (await codex.getAttribute('data-node-id'))!
  // command codex заменён на echo в настройках — видим собранную строку запуска.
  await expect.poll(() => screen(id), { timeout: 20000 }).toContain('mcp_servers.cnv={url=')
  expect(await screen(id)).toContain('bearer_token_env_var=')
  // Убираем: он встал по центру поверх первого агента и закрыл бы его шапку.
  await h.page.locator('[data-testid="viewport"]').click({ position: { x: 5, y: 5 } })
  await codex.click({ position: { x: 300, y: 5 } })
  await h.page.keyboard.press('Delete')
  await expect(codex).toHaveCount(0)
})

test('⟲ в шапке агента — выбрать старую сессию: агент перезапускается и продолжает её', async () => {
  const node = h.page.locator(`[data-node-id="${fakeId}"]`)
  // Всё в кадр: после прошлых тестов агент мог уехать за край.
  await h.page.locator('.hud__icon').nth(0).click()
  await node.getByTestId('header-session').click()
  const picker = h.page.getByTestId('session-picker')
  await expect(picker.locator('[data-session]')).toHaveCount(2)
  await expect(picker).toContainText('Уголки для стойки')
  await picker.locator('[data-session="old-session-bbb"]').click()
  await expect(picker).toHaveCount(0)
  await expect.poll(() => screen(fakeId), { timeout: 20000 }).toContain('FAKE_RESUME old-session-bbb')
  await expect
    .poll(async () => (await canvasJson()).nodes.find((n) => n.id === fakeId)?.['x-cnv']?.terminal?.agent)
    .toEqual({ plugin: 'fake', sessionId: 'old-session-bbb' })
})

test('«Продолжить сессию…» в списке агентов — новый агент сразу в старой сессии', async () => {
  const before = await h.page.locator('[data-node-kind="terminal"]').count()
  await h.page.locator('.create-bar__item[data-kind="agent"]').click({ button: 'right' })
  await h.page.getByTestId('create-resume').click()
  await h.page.getByTestId('session-picker').locator('[data-session="old-session-aaa"]').click()
  await expect(h.page.locator('[data-node-kind="terminal"]')).toHaveCount(before + 1)
  const created = h.page.locator('[data-node-kind="terminal"]').last()
  const id = (await created.getAttribute('data-node-id'))!
  await expect.poll(() => screen(id), { timeout: 20000 }).toContain('FAKE_RESUME old-session-aaa')
})
