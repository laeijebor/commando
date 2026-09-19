import { useWindowDimensions } from 'react-native'

/**
 * How much room the app has to lay itself out in.
 *
 * - `phone` — one screen at a time, the iPhone behaviour.
 * - `tablet` — two columns: the terminal and the HUD, with the sessions list
 *   as a slide-over. Portrait iPad and the wider Split View columns.
 * - `wide` — the three-column cockpit of mockup 10: sessions, terminal, HUD.
 */
export type LayoutMode = 'phone' | 'tablet' | 'wide'

/** Three columns need the 300 + 340 side columns plus a usable terminal. */
export const WIDE_BREAKPOINT = 900

/** Below this the terminal and the HUD cannot both stay readable. */
export const TABLET_BREAKPOINT = 700

/**
 * A landscape iPhone is wide but short: iPhone 16 Pro Max is 956 × 440pt, which
 * clears `WIDE_BREAKPOINT` on width alone. Every iPad configuration that should
 * get columns is at least 600pt tall (a half-height Split View column on a
 * 1024pt-tall iPad is 1024 or 768 wide but never under 700 tall).
 */
export const MIN_COLUMN_HEIGHT = 600

export type LayoutSize = { width: number; height: number }

/** Pure so the breakpoints can be tested without a window. */
export function layoutModeFor({ width, height }: LayoutSize): LayoutMode {
  if (height < MIN_COLUMN_HEIGHT) return 'phone'
  if (width >= WIDE_BREAKPOINT) return 'wide'
  if (width >= TABLET_BREAKPOINT) return 'tablet'
  return 'phone'
}

/** True for the layouts that put the terminal beside the HUD. */
export function isCockpitMode(mode: LayoutMode): boolean {
  return mode !== 'phone'
}

/**
 * The current layout mode. `useWindowDimensions` re-renders on rotation and on
 * a Split View drag, so a resize moves between the modes on its own.
 */
export function useLayoutMode(): LayoutMode {
  const { width, height } = useWindowDimensions()
  return layoutModeFor({ width, height })
}

/** The cockpit's fixed column widths, straight from the mockup's grid. */
export const SESSIONS_COLUMN_WIDTH = 300
export const HUD_COLUMN_WIDTH = 340
