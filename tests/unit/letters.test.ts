import { describe, expect, it, vi } from 'vitest'
import type { AgentLetter } from '@shared/agent-plugin'
import { LetterPost, channelMessage, type LetterPostDeps } from '../../src/main/mcp/letters'
import { claudeInputDraft } from '../../src/main/agents/builtin/claude'
import { humanTyping, noteHumanInput } from '../../src/main/human-typing'

const letter = (id: string, text = `письмо ${id}`): AgentLetter => ({ id, text, from: { id: 'n1', name: 'Даня' } })

function fakeDeps(over: Partial<LetterPostDeps> = {}): LetterPostDeps & { typed: string[] } {
  const typed: string[] = []
  return {
    typed,
    isRunning: () => true,
    write: (_n, data) => {
      if (data !== '\r') typed.push(data.replace('\x1b[200~', '').replace('\x1b[201~', ''))
    },
    sleep: async () => undefined,
    readScreen: async () => null,
    inputDraft: () => undefined,
    humanTyping: () => ({ draft: false, idleMs: Infinity }),
    usesChannel: () => false,
    hasStream: () => false,
    push: () => 0,
    deliver: async () => false,
    ...over
  }
}

describe('почтальон писем агентам', () => {
  it('канал есть — уведомлением, в терминал ничего не печатается', async () => {
    const push = vi.fn(() => 1)
    const deps = fakeDeps({ usesChannel: () => true, hasStream: () => true, push })
    expect(await new LetterPost(deps).send('a', letter('m1'))).toBe('channel')
    expect(push).toHaveBeenCalledWith('a', channelMessage(letter('m1')))
    expect(deps.typed).toEqual([])
  })

  it('плагин доставил своим способом — мимо терминала', async () => {
    const deps = fakeDeps({ deliver: async () => true })
    expect(await new LetterPost(deps).send('a', letter('m1'))).toBe('agent')
    expect(deps.typed).toEqual([])
  })

  it('поле ввода пусто — вставка в терминал', async () => {
    const deps = fakeDeps({ readScreen: async () => 'экран', inputDraft: () => '' })
    expect(await new LetterPost(deps).send('a', letter('m1'))).toBe('terminal')
    expect(deps.typed).toEqual(['письмо m1'])
  })

  it('черновик на экране — письма ждут и уходят по порядку, когда поле опустело', async () => {
    vi.useFakeTimers()
    let draft = 'недописанн'
    const deps = fakeDeps({ readScreen: async () => 'экран', inputDraft: () => draft })
    const post = new LetterPost(deps)
    expect(await post.send('a', letter('m1'))).toBe('queued')
    expect(await post.send('a', letter('m2'))).toBe('queued')
    await vi.advanceTimersByTimeAsync(3000)
    expect(deps.typed).toEqual([])
    draft = ''
    await vi.advanceTimersByTimeAsync(1500)
    expect(deps.typed).toEqual(['письмо m1', 'письмо m2'])
    expect(post.pending('a')).toBe(0)
    post.stop()
    vi.useRealTimers()
  })

  it('экран не разобрать — черновик по нажатиям', async () => {
    const deps = fakeDeps({ humanTyping: () => ({ draft: true, idleMs: 2000 }) })
    const post = new LetterPost(deps)
    expect(await post.send('a', letter('m1'))).toBe('queued')
    post.stop()
  })

  it('агент с каналом ещё не подключился — ждём поток, а не печатаем в его стартовый диалог', async () => {
    const deps = fakeDeps({ usesChannel: () => true, hasStream: () => false })
    const post = new LetterPost(deps)
    expect(await post.send('a', letter('m1'))).toBe('queued')
    expect(deps.typed).toEqual([])
    post.stop()
  })

  it('агент с каналом так и не подключился, а на экране не поле ввода — не вставляем в диалог', async () => {
    vi.useFakeTimers()
    const deps = fakeDeps({
      usesChannel: () => true,
      hasStream: () => false,
      readScreen: async () => 'WARNING: Loading development channels',
      inputDraft: () => null
    })
    const post = new LetterPost(deps)
    expect(await post.send('a', letter('m1'))).toBe('queued')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(deps.typed).toEqual([])
    post.stop()
    vi.useRealTimers()
  })

  it('мета канала — только латиница и _: Claude Code иначе её выбросит', () => {
    const meta = (channelMessage(letter('m1')) as { params: { meta: Record<string, string> } }).params.meta
    expect(Object.keys(meta).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))).toBe(true)
    expect(meta).toMatchObject({ msg_id: 'm1', from_id: 'n1', from: 'Даня' })
  })
})

describe('черновик в поле ввода Claude Code', () => {
  const rule = '─'.repeat(60)
  const screen = (input: string[]): string =>
    ['● ответ агента', '', rule, ...input, rule, '  Opus 5.5 | context: 3%', '  ⏵⏵ auto mode on'].join('\n')

  it('пустое поле и подсказка — не черновик', () => {
    expect(claudeInputDraft(screen(['❯ ']))).toBe('')
    expect(claudeInputDraft(screen(['❯ Try "refactor <filepath>"']))).toBe('')
  })

  it('набранный текст, в том числе многострочный', () => {
    expect(claudeInputDraft(screen(['❯ привет, глянь']))).toBe('привет, глянь')
    expect(claudeInputDraft(screen(['❯ раз', '  два']))).toBe('раз\n  два')
  })

  it('не тот экран (диалог) — не разобрать', () => {
    expect(claudeInputDraft('WARNING: Loading development channels\n❯ 1. I am using this')).toBeNull()
  })
})

describe('черновик по нажатиям', () => {
  it('набрал — черновик; Enter, Ctrl+C, Ctrl+U — пусто; стрелки и фокус — не текст', () => {
    noteHumanInput('t', 'при')
    expect(humanTyping('t').draft).toBe(true)
    noteHumanInput('t', '\r')
    expect(humanTyping('t').draft).toBe(false)
    noteHumanInput('t', '\x1b[A\x1b[I\x1b[O')
    expect(humanTyping('t').draft).toBe(false)
    noteHumanInput('t', 'ещё')
    noteHumanInput('t', '\x15')
    expect(humanTyping('t').draft).toBe(false)
    noteHumanInput('t', 'x')
    noteHumanInput('t', '\x03')
    expect(humanTyping('t').draft).toBe(false)
    noteHumanInput('t', 'отправил\rи снова пишу')
    expect(humanTyping('t').draft).toBe(true)
  })
})
