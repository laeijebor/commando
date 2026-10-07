export type ThemeName = 'purple' | 'emerald' | 'ocean' | 'rose' | 'amber' | 'cursor'

/** xterm.js ITheme shape; the native desktop terminal receives the same colors. */
export type TerminalTheme = {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  selectionInactiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export type Theme = {
  name: ThemeName
  label: string
  /** --bg for the theme; mirrored into the theme-color meta tag. */
  bg: string
  terminal: TerminalTheme
}

const ROSE_PINE_MOON_TERMINAL: TerminalTheme = {
  background: '#232136',
  foreground: '#e0def4',
  cursor: '#e0def4',
  cursorAccent: '#232136',
  selectionBackground: '#44415a',
  selectionForeground: '#e0def4',
  selectionInactiveBackground: '#393552',
  black: '#393552',
  red: '#eb6f92',
  green: '#3e8fb0',
  yellow: '#f6c177',
  blue: '#9ccfd8',
  magenta: '#c4a7e7',
  cyan: '#ea9a97',
  white: '#e0def4',
  brightBlack: '#6e6a86',
  brightRed: '#eb6f92',
  brightGreen: '#3e8fb0',
  brightYellow: '#f6c177',
  brightBlue: '#9ccfd8',
  brightMagenta: '#c4a7e7',
  brightCyan: '#ea9a97',
  brightWhite: '#e0def4',
}

const CURSOR_TERMINAL: TerminalTheme = {
  background: '#181818',
  foreground: '#d6d6d6',
  cursor: '#e4e4e4',
  cursorAccent: '#181818',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#3a3d41',
  black: '#3c3c3c',
  red: '#f14c4c',
  green: '#23d18b',
  yellow: '#e5c07b',
  blue: '#3b8eea',
  magenta: '#d670d6',
  cyan: '#29b8db',
  white: '#cccccc',
  brightBlack: '#666666',
  brightRed: '#ff6b6b',
  brightGreen: '#4be0a0',
  brightYellow: '#f5d58a',
  brightBlue: '#6aa7f8',
  brightMagenta: '#e38be3',
  brightCyan: '#5fcde8',
  brightWhite: '#ffffff',
}

export const THEMES: Theme[] = [
  { name: 'purple', label: 'Purple', bg: '#0c0a14', terminal: ROSE_PINE_MOON_TERMINAL },
  { name: 'emerald', label: 'Emerald', bg: '#0a140f', terminal: ROSE_PINE_MOON_TERMINAL },
  { name: 'ocean', label: 'Ocean', bg: '#0a1014', terminal: ROSE_PINE_MOON_TERMINAL },
  { name: 'rose', label: 'Rose', bg: '#140a0c', terminal: ROSE_PINE_MOON_TERMINAL },
  { name: 'amber', label: 'Amber', bg: '#14110a', terminal: ROSE_PINE_MOON_TERMINAL },
  { name: 'cursor', label: 'Cursor', bg: '#141414', terminal: CURSOR_TERMINAL },
]

export const DEFAULT_THEME: ThemeName = 'purple'

const STORAGE_KEY = 'commando-theme'
const CHANGE_EVENT = 'commando:theme-change'

function isThemeName(value: unknown): value is ThemeName {
  return THEMES.some((theme) => theme.name === value)
}

export function storedTheme(): ThemeName {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return isThemeName(value) ? value : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function themeByName(name: ThemeName): Theme {
  return THEMES.find((theme) => theme.name === name) ?? THEMES[0]
}

/** The theme currently applied to the document. */
export function activeTheme(): Theme {
  const name = document.documentElement.dataset.theme
  return themeByName(isThemeName(name) ? name : DEFAULT_THEME)
}

/** Calls listener with the new theme whenever applyTheme runs; returns an unsubscribe. */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  const handler = () => listener(activeTheme())
  window.addEventListener(CHANGE_EVENT, handler)
  return () => window.removeEventListener(CHANGE_EVENT, handler)
}

export function applyTheme(name: ThemeName): void {
  const root = document.documentElement
  if (name === DEFAULT_THEME) delete root.dataset.theme
  else root.dataset.theme = name
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', themeByName(name).bg)
  try {
    window.localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // Persistence is best-effort; the theme still applies for this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}
