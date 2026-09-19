import type { AgentStatusKind } from '@commando/protocol'

/**
 * The five desktop themes, ported token for token from `src/styles.css`
 * (`:root` plus each `:root[data-theme=...]` block). Only the surface, border,
 * text and accent ramps vary; green / cyan / amber / red are semantic and
 * shared, so status colours read the same in every theme.
 */
export const THEME_NAMES = ['purple', 'emerald', 'ocean', 'rose', 'amber'] as const

export type ThemeName = (typeof THEME_NAMES)[number]

export const DEFAULT_THEME_NAME: ThemeName = 'purple'

export type ThemePalette = {
  surfaceDeep: string
  bg: string
  surface: string
  surfaceRaised: string
  surfaceSoft: string
  surfaceHover: string
  border: string
  borderMid: string
  borderStrong: string
  text: string
  textSoft: string
  textDim: string
  textFaint: string
  muted: string
  mutedDim: string
  accent: string
  accentInk: string
}

/** Theme-invariant colours (`--green` … `--red` in `src/styles.css`). */
export const SEMANTIC = {
  green: '#85f4b1',
  cyan: '#73d9e2',
  amber: '#f3c66b',
  red: '#ff8d89',
  purple: '#b9a3ff',
  terminalBg: '#0a0a0a',
} as const

export type Theme = ThemePalette & typeof SEMANTIC & { name: ThemeName; label: string }

const PALETTES: Record<ThemeName, ThemePalette> = {
  purple: {
    surfaceDeep: '#0a0812',
    bg: '#0c0a14',
    surface: '#100d1a',
    surfaceRaised: '#131020',
    surfaceSoft: '#181428',
    surfaceHover: '#1f1a31',
    border: '#2c2542',
    borderMid: '#363048',
    borderStrong: '#443a63',
    text: '#f5f3fa',
    textSoft: '#c6c0d6',
    textDim: '#655f78',
    textFaint: '#524f67',
    muted: '#8f87a6',
    mutedDim: '#7a7590',
    accent: '#b9a3ff',
    accentInk: '#0e0a1c',
  },
  emerald: {
    surfaceDeep: '#08120d',
    bg: '#0a140f',
    surface: '#0d1a14',
    surfaceRaised: '#102019',
    surfaceSoft: '#14281f',
    surfaceHover: '#1a3126',
    border: '#254234',
    borderMid: '#30483d',
    borderStrong: '#3a6350',
    text: '#f3faf7',
    textSoft: '#c0d6cc',
    textDim: '#5f786c',
    textFaint: '#4f675c',
    muted: '#87a698',
    mutedDim: '#759083',
    accent: '#a3ffd4',
    accentInk: '#0a1c14',
  },
  ocean: {
    surfaceDeep: '#080e12',
    bg: '#0a1014',
    surface: '#0d151a',
    surfaceRaised: '#101920',
    surfaceSoft: '#142028',
    surfaceHover: '#1a2731',
    border: '#253642',
    borderMid: '#303e48',
    borderStrong: '#3a5263',
    text: '#f3f7fa',
    textSoft: '#c0cdd6',
    textDim: '#5f6e78',
    textFaint: '#4f5d67',
    muted: '#8799a6',
    mutedDim: '#758590',
    accent: '#a3d9ff',
    accentInk: '#0a141c',
  },
  rose: {
    surfaceDeep: '#12080a',
    bg: '#140a0c',
    surface: '#1a0d10',
    surfaceRaised: '#201014',
    surfaceSoft: '#281419',
    surfaceHover: '#311a20',
    border: '#42252c',
    borderMid: '#483036',
    borderStrong: '#633a44',
    text: '#faf3f5',
    textSoft: '#d6c0c6',
    textDim: '#785f65',
    textFaint: '#674f55',
    muted: '#a6878f',
    mutedDim: '#90757c',
    accent: '#ffa3ba',
    accentInk: '#1c0a0e',
  },
  amber: {
    surfaceDeep: '#120f08',
    bg: '#14110a',
    surface: '#1a160d',
    surfaceRaised: '#201b10',
    surfaceSoft: '#282114',
    surfaceHover: '#31291a',
    border: '#423825',
    borderMid: '#484030',
    borderStrong: '#63553a',
    text: '#faf8f3',
    textSoft: '#d6cfc0',
    textDim: '#78705f',
    textFaint: '#675f4f',
    muted: '#a69c87',
    mutedDim: '#908775',
    accent: '#ffe0a3',
    accentInk: '#1c160a',
  },
}

const LABELS: Record<ThemeName, string> = {
  purple: 'Purple',
  emerald: 'Emerald',
  ocean: 'Ocean',
  rose: 'Rose',
  amber: 'Amber',
}

export const THEMES: Record<ThemeName, Theme> = Object.fromEntries(
  THEME_NAMES.map((name) => [name, { ...PALETTES[name], ...SEMANTIC, name, label: LABELS[name] }]),
) as Record<ThemeName, Theme>

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value)
}

/**
 * Status colours mirror the desktop HUD: working reads as the accent, a
 * pending question is amber, a finished agent is green, a failure is red and
 * anything stale or unknown falls back to the dimmed muted tone.
 */
export function statusColor(theme: Theme, status: AgentStatusKind): string {
  switch (status) {
    case 'working':
      return theme.accent
    case 'needs_input':
      return theme.amber
    case 'done':
      return theme.green
    case 'failed':
      return theme.red
    default:
      return theme.mutedDim
  }
}

export function statusLabel(status: AgentStatusKind): string {
  switch (status) {
    case 'needs_input':
      return 'Needs you'
    case 'working':
      return 'Working'
    case 'done':
      return 'Done'
    case 'failed':
      return 'Failed'
    case 'stale':
      return 'Idle'
    default:
      return 'Unknown'
  }
}
