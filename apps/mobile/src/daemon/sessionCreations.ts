import type { TmuxCreateResponse } from '@commando/tmux-create'

import { useDaemonStore } from './store'

type Finish = (result: TmuxCreateResponse) => void | Promise<void>

/** Creations this device started and left running, keyed by host and creation id. */
const waiting = new Map<string, { hostId: string; id: string; finish: Finish }>()
let unsubscribe: (() => void) | null = null

function settle(): void {
  const byHost = useDaemonStore.getState().byHost
  for (const [key, entry] of waiting) {
    const creation = byHost[entry.hostId]?.sessionCreations.find((candidate) => candidate.id === entry.id)
    if (creation?.stage !== 'done' || !creation.result) continue
    waiting.delete(key)
    // Nothing is on screen to report to by now; the session itself has appeared in the list.
    void Promise.resolve().then(() => entry.finish(creation.result!)).catch((error: unknown) => {
      console.warn('Finishing a background session creation failed', error)
    })
  }
  if (!waiting.size) {
    unsubscribe?.()
    unsubscribe = null
  }
}

/**
 * Runs `finish` once the daemon reports the creation done, however long the checkout takes and
 * through retries after a failure. The phone has left the New session screen by then, so this is
 * only for bookkeeping that does not navigate.
 */
export function whenSessionCreated(hostId: string, id: string, finish: Finish): void {
  waiting.set(`${hostId}\n${id}`, { hostId, id, finish })
  unsubscribe ??= useDaemonStore.subscribe(settle)
  settle()
}

/** Stops waiting for a creation the user dismissed. */
export function forgetSessionCreation(hostId: string, id: string): void {
  waiting.delete(`${hostId}\n${id}`)
}
