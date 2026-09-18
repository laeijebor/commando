import { useEffect } from 'react'
import { create } from 'zustand'

import {
  readPreference,
  TERMINAL_FIT_PREFERENCE_KEY,
  TERMINAL_FONT_SIZE_PREFERENCE_KEY,
  writePreference,
} from '../prefs'

/**
 * Decision 2 renders a pane at its source size, so the font size is a setting
 * rather than something a pinch changes. These are the sizes the picker offers.
 */
export const TERMINAL_FONT_SIZES = [9, 10, 11, 12, 13, 14] as const

export const DEFAULT_TERMINAL_FONT_SIZE = 11

/** "Fit to phone" takes the resize lease, so it is off unless asked for. */
export const DEFAULT_FIT_TO_PHONE = false

type TerminalPrefsState = {
  /** The default a newly opened pane screen starts with. */
  fitToPhone: boolean
  fontSize: number
  hydrated: boolean
  hydrate: () => Promise<void>
  setFitToPhone: (value: boolean) => void
  setFontSize: (value: number) => void
}

export const useTerminalPrefs = create<TerminalPrefsState>((set, get) => ({
  fitToPhone: DEFAULT_FIT_TO_PHONE,
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return
    const [fit, fontSize] = await Promise.all([
      readPreference(TERMINAL_FIT_PREFERENCE_KEY),
      readPreference(TERMINAL_FONT_SIZE_PREFERENCE_KEY),
    ])
    const parsedFontSize = Number.parseInt(fontSize ?? '', 10)
    set({
      hydrated: true,
      fitToPhone: fit === null ? DEFAULT_FIT_TO_PHONE : fit === 'true',
      fontSize: Number.isFinite(parsedFontSize) && parsedFontSize > 0
        ? parsedFontSize
        : DEFAULT_TERMINAL_FONT_SIZE,
    })
  },

  setFitToPhone: (value) => {
    set({ fitToPhone: value })
    void writePreference(TERMINAL_FIT_PREFERENCE_KEY, String(value))
  },

  setFontSize: (value) => {
    set({ fontSize: value })
    void writePreference(TERMINAL_FONT_SIZE_PREFERENCE_KEY, String(value))
  },
}))

/** Reads the stored terminal settings once, for screens that need them. */
export function useHydratedTerminalPrefs(): TerminalPrefsState {
  const state = useTerminalPrefs()
  const hydrate = state.hydrate
  useEffect(() => {
    void hydrate()
  }, [hydrate])
  return state
}
