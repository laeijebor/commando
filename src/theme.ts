export type ThemeName = 'purple' | 'emerald' | 'ocean' | 'rose' | 'amber'

export type Theme = {
  name: ThemeName
  label: string
  /** --bg for the theme; mirrored into the theme-color meta tag. */
  bg: string
}

export const THEMES: Theme[] = [
  { name: 'purple', label: 'Purple', bg: '#0c0a14' },
  { name: 'emerald', label: 'Emerald', bg: '#0a140f' },
  { name: 'ocean', label: 'Ocean', bg: '#0a1014' },
  { name: 'rose', label: 'Rose', bg: '#140a0c' },
  { name: 'amber', label: 'Amber', bg: '#14110a' },
]

export const DEFAULT_THEME: ThemeName = 'purple'

const STORAGE_KEY = 'commando-theme'

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

export function applyTheme(name: ThemeName): void {
  const root = document.documentElement
  if (name === DEFAULT_THEME) delete root.dataset.theme
  else root.dataset.theme = name
  const meta = document.querySelector('meta[name="theme-color"]')
  const theme = THEMES.find((entry) => entry.name === name)
  if (meta && theme) meta.setAttribute('content', theme.bg)
  try {
    window.localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // Persistence is best-effort; the theme still applies for this session.
  }
}
