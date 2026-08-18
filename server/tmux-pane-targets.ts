import { randomUUID } from 'node:crypto'

import { isCommandoTargetId } from '../shared/pane-target.js'

const PANE_ID = /^%\d+$/
export const TMUX_PANE_TARGET_OPTION = '@commando_target'

export type PaneTargetObservation = {
  paneId: string
  storedValue: string
}

export function parseStoredPaneTarget(value: string, paneId: string): string | null {
  if (!PANE_ID.test(paneId)) return null
  const match = /^v1:(%\d+):([0-9a-f-]+)$/.exec(value)
  if (!match || match[1] !== paneId || !isCommandoTargetId(match[2])) return null
  return match[2]
}

export class TmuxPaneTargets {
  constructor(
    private readonly persist: (paneId: string, value: string) => Promise<void>,
    private readonly generate: () => string = randomUUID,
  ) {}

  async reconcile(observations: readonly PaneTargetObservation[]): Promise<ReadonlyMap<string, string>> {
    const parsed = observations.map(({ paneId, storedValue }) => ({
      paneId,
      targetId: parseStoredPaneTarget(storedValue, paneId),
    }))
    const counts = new Map<string, number>()
    for (const { targetId } of parsed) {
      if (targetId) counts.set(targetId, (counts.get(targetId) ?? 0) + 1)
    }

    const reserved = new Set(counts.keys())
    const targets = new Map<string, string>()
    for (const { paneId, targetId } of parsed) {
      if (targetId && counts.get(targetId) === 1) {
        targets.set(paneId, targetId)
        continue
      }

      let generated: string
      do generated = this.generate()
      while (!isCommandoTargetId(generated) || reserved.has(generated))
      reserved.add(generated)
      await this.persist(paneId, `v1:${paneId}:${generated}`)
      targets.set(paneId, generated)
    }
    return targets
  }
}
