import { useSyncExternalStore } from 'react'
import { onThemeChange } from './theme'

/** Reads a CSS custom property, such as `--surface`; empty when it isn't set. */
export type CssVariableReader = (name: string) => string

const FALLBACKS: Record<string, string> = {
  '--surface-deep': '#0a0812',
  '--surface': '#100d1a',
  '--surface-raised': '#131020',
  '--surface-soft': '#181428',
  '--surface-hover': '#1f1a31',
  '--border': '#2c2542',
  '--border-mid': '#363048',
  '--border-strong': '#443a63',
  '--text': '#f5f3fa',
  '--text-soft': '#c6c0d6',
  '--muted': '#8f87a6',
  '--accent': '#b9a3ff',
  '--accent-ink': '#0e0a1c',
}

/** Relative luminance of a #rgb or #rrggbb colour; undefined for anything else. */
function luminance(colour: string): number | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour)?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(full.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Mermaid's `base` theme variables from Commando's theme, so a diagram's
 * nodes, lines and notes use the same surfaces, borders, text and accent as
 * the chat around it.
 */
export function mermaidThemeVariables(read: CssVariableReader): Record<string, string | boolean> {
  const v = (name: string) => read(name).trim() || FALLBACKS[name]
  const surface = v('--surface')
  const raised = v('--surface-raised')
  const soft = v('--surface-soft')
  const hover = v('--surface-hover')
  const border = v('--border')
  const strong = v('--border-strong')
  const text = v('--text')
  const textSoft = v('--text-soft')
  const muted = v('--muted')
  const accent = v('--accent')
  return {
    darkMode: (luminance(surface) ?? 0) < 0.4,
    background: surface,
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    textColor: text,
    lineColor: muted,
    primaryColor: soft,
    primaryTextColor: text,
    primaryBorderColor: strong,
    secondaryColor: raised,
    secondaryTextColor: textSoft,
    secondaryBorderColor: border,
    tertiaryColor: hover,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    mainBkg: soft,
    nodeBorder: strong,
    nodeTextColor: text,
    clusterBkg: raised,
    clusterBorder: border,
    titleColor: text,
    edgeLabelBackground: raised,
    actorBkg: soft,
    actorBorder: strong,
    actorTextColor: text,
    actorLineColor: muted,
    signalColor: textSoft,
    signalTextColor: text,
    labelBoxBkgColor: raised,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: textSoft,
    noteBkgColor: hover,
    noteTextColor: text,
    noteBorderColor: accent,
    activationBkgColor: hover,
    activationBorderColor: accent,
    sequenceNumberColor: v('--accent-ink'),
  }
}

/** The theme variables for the document's current theme. */
export function documentMermaidThemeVariables(): Record<string, string | boolean> {
  const style = getComputedStyle(document.documentElement)
  return mermaidThemeVariables((name) => style.getPropertyValue(name))
}

const themeName = () => document.documentElement.dataset.theme ?? ''

/** The active theme's name; a component using it re-renders when the theme changes. */
export function useThemeName(): string {
  return useSyncExternalStore(onThemeChange, themeName, () => '')
}
