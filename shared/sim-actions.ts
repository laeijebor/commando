export const SIM_TEXT_SIZES = ['extra-small', 'small', 'medium', 'large', 'extra-large', 'extra-extra-large',
  'extra-extra-extra-large', 'accessibility-medium', 'accessibility-large', 'accessibility-extra-large',
  'accessibility-extra-extra-large', 'accessibility-extra-extra-extra-large'] as const
export const SIM_NETWORK_PROFILES = ['off', 'offline', '3g', 'lte', 'lossy'] as const
export const SIM_ORIENTATIONS = ['portrait', 'landscape-left', 'landscape-right', 'portrait-upside-down'] as const
export type SimOrientation = typeof SIM_ORIENTATIONS[number]
export type SimAction =
  | { action: 'orientation'; value: SimOrientation }
  | { action: 'appearance'; value: 'light' | 'dark' | 'toggle' }
  | { action: 'shake' | 'heal' }
  | { action: 'status-bar'; mode: 'clean' | 'clear' }
  | { action: 'open-url'; url: string }
  | { action: 'text-size'; value: typeof SIM_TEXT_SIZES[number]; step?: never }
  | { action: 'text-size'; step: 1 | -1; value?: never }
  | { action: 'contrast' | 'reduce-motion'; enabled: boolean }
  | { action: 'network'; profile: typeof SIM_NETWORK_PROFILES[number] }
export type SimActionResult = { ok: true; value?: 'light' | 'dark'; warning?: string }
