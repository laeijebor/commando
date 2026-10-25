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
 * page on screen; `sentPage` should be a page key (origin + path), so in-page
 * navigation does not churn the connection.
 */
export function usePendingQueue(
  host: Host | undefined,
  tile: WebPane | undefined,
  sentPage: string | null,
  enabled: boolean,
): { pending: WebPanePendingSnapshot; apply: (snapshot: WebPanePendingSnapshot) => void; reload: () => void } {
  const cookie = useHostsStore((store) => (host ? store.cookies[host.id] : undefined))
  const [pending, setPending] = useState<WebPanePendingSnapshot>(EMPTY_PENDING)
  const tileId = tile?.id
  const chromium = tile?.engine === 'chromium' && !tile.content

  // Only the newest read may land: an older `sentPage` reply arriving late
  // would put another page's sent answers on this one.
  const latestRequest = useRef(0)
  const reload = useCallback(() => {
    if (!host || !tileId) return
    const request = ++latestRequest.current
    void fetchPendingNotes(host, tileId, sentPage ?? undefined)
      .then((snapshot) => {
        if (request !== latestRequest.current) return
        setPending((current) => mergePendingSnapshot(current, snapshot, { keepSent: false }))
      })
      .catch(() => undefined)
  }, [host, tileId, sentPage])
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  const apply = useCallback((snapshot: WebPanePendingSnapshot) => {
    setPending((current) => mergePendingSnapshot(current, snapshot, { keepSent: true }))
    // The reply's sent answers may belong to another page; read ours again.
    reloadRef.current()
  }, [])

  useEffect(() => {
    latestRequest.current += 1
    setPending(EMPTY_PENDING)
  }, [host?.id, tileId])

  // A new page (origin + path) needs its own sent answers.
  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])

  // The push channel or the poll lives as long as the tile, not the page.
  useEffect(() => {
    if (!enabled || !host || !tileId) return
    if (chromium) {
      const client = new TileRelayClient({ host, webPaneId: tileId, cookie: cookie ?? null, mode: 'review' })
      let lastRevision: number | undefined
      let lastCount = -1
      const unsubscribe = client.subscribe((state) => {
        const { revision, notes } = state.pending
        if (revision === lastRevision && notes.length === lastCount) return
        lastRevision = revision
        lastCount = notes.length
        reloadRef.current()
      })
      client.start()
      return () => {
        unsubscribe()
        client.stop()
      }
    }
    const timer = setInterval(() => reloadRef.current(), POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, host, tileId, chromium, cookie])

  return { pending, apply, reload }
}
