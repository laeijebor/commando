import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { readPreference, THEME_PREFERENCE_KEY, writePreference } from '../prefs'
import { DEFAULT_THEME_NAME, isThemeName, THEMES, type Theme, type ThemeName } from './themes'

type ThemeContextValue = {
  theme: Theme
  themeName: ThemeName
  setThemeName: (name: ThemeName) => void
  /** False until the stored choice has been read, so nothing flashes twice. */
  hydrated: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [themeName, setThemeNameState] = useState<ThemeName>(DEFAULT_THEME_NAME)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    void readPreference(THEME_PREFERENCE_KEY).then((stored) => {
      if (cancelled) return
      if (isThemeName(stored)) setThemeNameState(stored)
      setHydrated(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({
    theme: THEMES[themeName],
    themeName,
    hydrated,
    setThemeName: (name: ThemeName) => {
      setThemeNameState(name)
      void writePreference(THEME_PREFERENCE_KEY, name)
    },
  }), [themeName, hydrated])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}

export function useTheme(): Theme {
  return useThemeContext().theme
}
