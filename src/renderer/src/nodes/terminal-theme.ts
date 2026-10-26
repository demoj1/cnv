import { useEffect, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import type { TerminalThemeMode } from '@shared/settings'

/**
 * Тема терминалов: как у cnv (по умолчанию) или всегда своя. Решённая тема висит на корне
 * документа — `data-term-theme`, — от неё зависят и обвязка ноды в CSS, и палитра xterm.
 */

export type TerminalTheme = 'dark' | 'light'

export const TERMINAL_THEMES: Record<TerminalTheme, ITheme> = {
  dark: {
    background: '#11131a',
    foreground: '#d5d8e0',
    cursor: '#d5d8e0',
    cursorAccent: '#11131a',
    selectionBackground: '#3a4152'
  },
  // Стандартные ANSI-цвета рассчитаны на тёмный фон: жёлтый и голубой на белом не читаются.
  // Здесь они темнее, «яркие» — чуть темнее обычных, а не светлее.
  light: {
    background: '#fbfbfc',
    foreground: '#1f2328',
    cursor: '#1f2328',
    cursorAccent: '#fbfbfc',
    selectionBackground: '#cfe0ff',
    black: '#1f2328',
    red: '#c4262f',
    green: '#1b7c3a',
    yellow: '#8a6100',
    blue: '#1f5fd1',
    magenta: '#8e3fb8',
    cyan: '#0f7a85',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a1121b',
    brightGreen: '#116329',
    brightYellow: '#6f4e00',
    brightBlue: '#0b4bb3',
    brightMagenta: '#73229b',
    brightCyan: '#08626b',
    brightWhite: '#8c959f'
  }
}

const read = (): TerminalTheme => (document.documentElement.dataset.termTheme === 'light' ? 'light' : 'dark')

/** Решить тему терминалов и повесить её на корень: следит и за темой cnv, и за системной. */
export function useTerminalThemeRoot(mode: TerminalThemeMode): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      root.dataset.termTheme = mode === 'app' ? (root.dataset.theme === 'dark' ? 'dark' : 'light') : mode
    }
    apply()
    // Тема cnv (data-theme) меняется в другом эффекте и от системной темы — следим за атрибутом.
    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [mode])
}

/** Текущая тема терминалов — меняется на лету. */
export function useTerminalTheme(): TerminalTheme {
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-term-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}
