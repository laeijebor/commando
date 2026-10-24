import { useCallback, useEffect, useRef, useState } from 'react'

import { useDaemonClient } from '../daemon/useDaemonConnection'
import { useHostState } from '../daemon/store'
import type { Host } from '../hosts/types'
import { cancelGuideUpdate, fetchGuide, fetchGuideMarkdown, markGuideStep, requestGuideUpdate, resetGuide } from './api'
import { guideEventScope, withOptimisticTick, type GuideContent, type GuideSnapshot } from './model'

/** `baseline` is the snapshot's deliveredAt when the update was queued, so the host's clock is the only one compared. */
export type GuideNotice = { kind: 'sent' | 'queued' | 'cancelled'; baseline?: number }

export type GuideController = {
  markdown: string | null
  snapshot: GuideSnapshot | null
  /** The Markdown could not be fetched (the folder was unregistered, the host is unreachable). */
  loadError: string
  /** A state read or a tick/note/update failed, or the daemon could not read the file. */
  error: string
  busy: ReadonlySet<string>
  sending: boolean
  /** The outcome of the last "Update agent" press, for the confirmation banner. */
  notice: GuideNotice | null
  live: boolean
  reload: () => void
  toggle: (id: string, checked: boolean) => void
  /** Resolves false when the note was not saved, so the editor can keep the draft. */
  saveNote: (id: string, note: string) => Promise<boolean>
  update: () => Promise<void>
  reset: () => Promise<void>
}

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

/**
 * One guide tab's Markdown and tick state, kept current the way the desktop's
 * GuidePane keeps it: `canvas_changed` for the file reloads both,
 * `guide_state_changed` reloads the state. A reconnect or a return to the
 * foreground reloads both, because events sent while the socket was down are
 * gone.
 */
export function useGuide(host: Host | undefined, webPaneId: string, content: GuideContent, active = true): GuideController {
  const client = useDaemonClient(host)
  const phase = useHostState(host?.id).phase
  const live = phase === 'live'
  const [markdown, setMarkdown] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [snapshot, setSnapshot] = useState<GuideSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<GuideNotice | null>(null)
  // A reply to an older read never overwrites a newer one (or a tick's answer).
  const sequence = useRef(0)
  const markdownSequence = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const { artifactId, file } = content

  const loadMarkdown = useCallback(async () => {
    if (!host) return
    const request = ++markdownSequence.current
    try {
      const text = await fetchGuideMarkdown(host, { artifactId, file })
      if (mounted.current && request === markdownSequence.current) { setMarkdown(text); setLoadError('') }
    } catch (reason) {
      if (mounted.current && request === markdownSequence.current) setLoadError(message(reason))
    }
  }, [host, artifactId, file])

  const loadState = useCallback(async () => {
    if (!host) return
    const request = ++sequence.current
    try {
      const next = await fetchGuide(host, webPaneId)
      if (mounted.current && request === sequence.current) { setSnapshot(next); setError(next.error ?? '') }
    } catch (reason) {
      if (mounted.current && request === sequence.current) setError(message(reason))
    }
  }, [host, webPaneId])

  const accept = useCallback((next: GuideSnapshot) => {
    ++sequence.current
    if (!mounted.current) return
    setSnapshot(next); setError(next.error ?? '')
  }, [])

  const reload = useCallback(() => { void loadMarkdown(); void loadState() }, [loadMarkdown, loadState])

  // First load (over HTTP, even before the socket is up), every reconnect, and every return to the foreground.
  const loaded = useRef(false)
  useEffect(() => {
    if (!active || (loaded.current && !live)) return
    loaded.current = true
    reload()
  }, [active, live, reload])

  useEffect(() => {
    if (!client) return
    return client.subscribe((event) => {
      const scope = guideEventScope(event, { artifactId, file })
      if (scope === 'all') reload()
      else if (scope === 'state') void loadState()
    })
  }, [client, artifactId, file, reload, loadState])

  /** Applies one change; false when the daemon refused it or could not be reached. */
  const run = useCallback(async (id: string, change: () => Promise<GuideSnapshot>, rollback?: () => void): Promise<boolean> => {
    setBusy((current) => new Set(current).add(id))
    try {
      accept(await change())
      return true
    } catch (reason) {
      if (!mounted.current) return false
      setError(message(reason))
      // Undo the optimistic tick (a reload may fail too, offline), then ask for the daemon's truth.
      rollback?.()
      void loadState()
      return false
    } finally {
      if (mounted.current) setBusy((current) => { const next = new Set(current); next.delete(id); return next })
    }
  }, [accept, loadState])

  const toggle = useCallback((id: string, checked: boolean) => {
    if (!host) return
    setSnapshot((current) => current && withOptimisticTick(current, id, checked))
    void run(id, () => markGuideStep(host, webPaneId, { id, checked }), () => {
      setSnapshot((current) => current && withOptimisticTick(current, id, !checked))
    })
  }, [host, run, webPaneId])

  const saveNote = useCallback(async (id: string, note: string): Promise<boolean> => {
    if (!host) return false
    return run(id, () => markGuideStep(host, webPaneId, { id, note }))
  }, [host, run, webPaneId])

  const update = useCallback(async () => {
    if (!host || !snapshot) return
    const cancelling = snapshot.waiting
    setSending(true); setNotice(null)
    try {
      const baseline = snapshot.deliveredAt
      const next = await (cancelling ? cancelGuideUpdate(host, webPaneId) : requestGuideUpdate(host, webPaneId))
      accept(next)
      if (mounted.current) setNotice(cancelling ? { kind: 'cancelled' } : next.waiting ? { kind: 'queued', ...(baseline ? { baseline } : {}) } : { kind: 'sent' })
    } catch (reason) {
      if (mounted.current) setError(message(reason))
    } finally {
      if (mounted.current) setSending(false)
    }
  }, [accept, host, snapshot, webPaneId])

  const reset = useCallback(async () => {
    if (!host) return
    try { accept(await resetGuide(host, webPaneId)) } catch (reason) { if (mounted.current) setError(message(reason)) }
  }, [accept, host, webPaneId])

  // A queued update turns into "sent" when the daemon delivers it, and goes away if the wait ends
  // without a delivery (cancelled elsewhere, or the changes were undone). New changes retire "sent".
  useEffect(() => {
    if (!notice || !snapshot) return
    if (notice.kind === 'queued' && !snapshot.waiting) setNotice(snapshot.deliveredAt !== undefined && snapshot.deliveredAt !== notice.baseline ? { kind: 'sent' } : null)
    else if (notice.kind !== 'queued' && snapshot.changes.length) setNotice(null)
  }, [notice, snapshot])

  return { markdown, snapshot, loadError, error, busy, sending, notice, live, reload, toggle, saveNote, update, reset }
}
