import { useCallback, useEffect, useRef, useState } from 'react'

import type { WebPane, WebPanePendingSnapshot } from '@commando/protocol'

import { useHostsStore } from '../../hosts/store'
import type { Host } from '../../hosts/types'
import { fetchPendingNotes } from '../api'
import { EMPTY_PENDING, TileRelayClient } from '../relay'

const POLL_MS = 4_000

/**
 * A newer snapshot wins; one without a revision (an old daemon) always does.
 * `sent` is kept from the last `sentPage` read: a mutation's reply carries
 * the sent answers of whatever page the daemon last heard about, which is not
 * necessarily the one on the phone.
 */
export function mergePendingSnapshot(
  current: WebPanePendingSnapshot,
  next: WebPanePendingSnapshot,
  options: { keepSent: boolean },
): WebPanePendingSnapshot {
  if (
    typeof current.revision === 'number' &&
    typeof next.revision === 'number' &&
    next.revision < current.revision
  ) return current
  if (!options.keepSent) return next
  const { sent: _ignored, ...rest } = next
  return current.sent ? { ...rest, sent: current.sent } : rest
}

/**
 * The tile's pending queue while the phone renders the page itself. A
 * chromium tile has a push channel without the screencast (`?mode=review`);
 * webkit tiles and canvases have none on the relay, so they poll while the
 * screen is up. Every push or poll re-reads `GET …/pending?sentPage=` for the
 * page on screen.
 */
export function usePendingQueue(
  host: Host | undefined,
  tile: WebPane | undefined,
  sentPage: string | null,
  enabled: boolean,
): { pending: WebPanePendingSnapshot; apply: (snapshot: WebPanePendingSnapshot) => void; reload: () => void } {
  const cookie = useHostsStore((store) => (host ? store.cookies[host.id] : undefined))
  const [pending, setPending] = useState<WebPanePendingSnapshot>(EMPTY_PENDING)
  const generation = useRef(0)
  const tileId = tile?.id
  const chromium = tile?.engine === 'chromium' && !tile.content

  const reload = useCallback(() => {
    if (!host || !tileId) return
    const request = generation.current
    void fetchPendingNotes(host, tileId, sentPage ?? undefined)
      .then((snapshot) => {
        if (request !== generation.current) return
        setPending((current) => mergePendingSnapshot(current, snapshot, { keepSent: false }))
      })
      .catch(() => undefined)
  }, [host, tileId, sentPage])

  const apply = useCallback((snapshot: WebPanePendingSnapshot) => {
    setPending((current) => mergePendingSnapshot(current, snapshot, { keepSent: true }))
    // The reply's sent answers may belong to another page; read ours again.
    reload()
  }, [reload])

  useEffect(() => {
    generation.current += 1
    setPending(EMPTY_PENDING)
  }, [host?.id, tileId])

  useEffect(() => {
    if (!enabled || !host || !tileId) return
    reload()
    if (chromium) {
      const client = new TileRelayClient({ host, webPaneId: tileId, cookie: cookie ?? null, mode: 'review' })
      let lastRevision: number | undefined
      let lastCount = -1
      const unsubscribe = client.subscribe((state) => {
        const { revision, notes } = state.pending
        if (revision === lastRevision && notes.length === lastCount) return
        lastRevision = revision
        lastCount = notes.length
        reload()
      })
      client.start()
      return () => {
        unsubscribe()
        client.stop()
      }
    }
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, host, tileId, chromium, cookie, reload])

  return { pending, apply, reload }
}
