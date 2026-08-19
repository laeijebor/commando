import type { PaneMarkTone } from '../shared/protocol'

export type PaneMarkPreset = {
  id: string
  label: string
  tone: PaneMarkTone
}

export const PANE_MARK_PRESETS: PaneMarkPreset[] = [
  { id: 'waiting-pr', label: 'Waiting for PR', tone: 'amber' },
  { id: 'ready-merge', label: 'Ready to merge', tone: 'green' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'release-window', label: 'Release window', tone: 'purple' },
  { id: 'parked', label: 'Parked', tone: 'muted' },
]
