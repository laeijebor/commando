import { useEffect, useMemo, useRef, useState } from 'react'
import type { SimWallDevice } from '../shared/protocol'
import { createSimsApi } from './simsApi'
import './sims-view.css'
import { SimLiveView } from './SimLiveView'

type SimsApi = ReturnType<typeof createSimsApi>

// Decode offscreen before replacing the displayed image. Abort also releases a pending decode.
function loadImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); image.removeAttribute('src'); reject(new DOMException('Aborted', 'AbortError')) }
    image.onload = () => { cleanup(); resolve() }
    image.onerror = () => { cleanup(); reject(new Error('Snapshot could not be loaded')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    image.src = url
  })
}

function SimCard({ sim, api, visible, onSlimmed, onLive }: {
  sim: SimWallDevice; api: SimsApi; visible: boolean; onSlimmed: () => void; onLive: (trigger: HTMLButtonElement) => void
}) {
  const card = useRef<HTMLElement>(null)
  const snapshotBusy = useRef(false)
  const actionBusy = useRef(false)
  const [intersecting, setIntersecting] = useState(false)
  const [image, setImage] = useState<string>()
  const [snapshotError, setSnapshotError] = useState('')
  const [error, setError] = useState('')
  const [action, setAction] = useState<'slim' | 'open' | null>(null)
  const name = sim.lease?.sessionName ?? sim.name

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting))
    if (card.current) observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => { if (image) URL.revokeObjectURL(image) }, [image])

  useEffect(() => {
    if (!visible || !intersecting) return
    const controller = new AbortController()
    const refresh = async () => {
      if (snapshotBusy.current || controller.signal.aborted || document.visibilityState !== 'visible') return
      snapshotBusy.current = true
      let next: string | undefined
      try {
        const blob = await api.snapshot(sim.udid, controller.signal)
        if (controller.signal.aborted) return
        next = URL.createObjectURL(blob)
        await loadImage(next, controller.signal)
        if (controller.signal.aborted) return
        setImage(next)
        next = undefined // Ownership passes to the image effect.
        setSnapshotError('')
      } catch (cause) {
        if (!controller.signal.aborted) setSnapshotError(cause instanceof Error ? cause.message : 'Snapshot unavailable')
      } finally {
        if (next) URL.revokeObjectURL(next)
        snapshotBusy.current = false
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [api, sim.udid, visible, intersecting])

  const perform = async (kind: 'slim' | 'open') => {
    if (actionBusy.current) return
    if (kind === 'slim' && !window.confirm('Slimming reboots this simulator')) return
    actionBusy.current = true
    setAction(kind)
    setError('')
    try {
      await api[kind](sim.udid)
      if (kind === 'slim') onSlimmed()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Simulator action failed') }
    finally { actionBusy.current = false; setAction(null) }
  }

  return <article className="sims-card" ref={card} aria-label={name}>
    <button type="button" className="sims-snapshot" onClick={(event) => onLive(event.currentTarget)} aria-label={`View ${name} live`}>
      {image ? <img src={image} alt={`${name} snapshot`} />
        : <span className="sims-placeholder">{snapshotError || 'Waiting for snapshot…'}</span>}
    </button>
    <div className="sims-name">{name}</div>
    <div className="sims-task">{sim.lease?.task || (sim.lease ? 'No task' : 'No lease')}</div>
    <div className="sims-meta">
      <span className={sim.slim}>{sim.slim === 'unknown' ? 'slim unknown' : sim.slim}</span>
      {sim.lease?.idle ? <span className="idle">idle</span> : null}
      <span>{sim.deviceModel}</span>
    </div>
    <div className="sims-actions">
      {sim.slim === 'unslimmed' ? <button type="button" disabled={action !== null} onClick={() => void perform('slim')}>{action === 'slim' ? 'Slimming…' : 'Slim'}</button> : null}
      <button type="button" disabled={action !== null} onClick={() => void perform('open')}>{action === 'open' ? 'Opening…' : 'Open in Simulator'}</button>
    </div>
    {image && snapshotError ? <p className="sims-error" role="status">{snapshotError}</p> : null}
    {error ? <p className="sims-error" role="alert">{error}</p> : null}
  </article>
}

export function SimsView({ token }: { token: string }) {
  const api = useMemo(() => createSimsApi(token), [token])
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  const [liveUdid, setLiveUdid] = useState<string | null>(null)
  const liveTrigger = useRef<HTMLElement | null>(null)
  const closeLive = () => { setLiveUdid(null); liveTrigger.current?.focus() }
  useEffect(() => {
    if (!liveUdid) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeLive() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [liveUdid])
  const [sims, setSims] = useState<SimWallDevice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const listingBusy = useRef(false)
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    const refresh = async () => {
      if (listingBusy.current || controller.signal.aborted || document.visibilityState !== 'visible') return
      listingBusy.current = true
      try {
        const next = await api.list(controller.signal)
        if (!controller.signal.aborted) { setSims(next); setLoaded(true); setError('') }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Simulators unavailable')
      } finally { listingBusy.current = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [api, visible, revision])

  const groups = new Map<string, { name: string; sims: SimWallDevice[] }>()
  for (const sim of sims.filter((device) => device.lease)) {
    const key = sim.lease!.repo?.root ?? ''
    const group = groups.get(key) ?? { name: sim.lease!.repo?.name ?? 'Unknown repository', sims: [] }
    group.sims.push(sim)
    groups.set(key, group)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))
  const unleased = sims.filter((sim) => !sim.lease)
  if (unleased.length) ordered.push(['no-lease', { name: 'No lease', sims: unleased }])

  return <section className="sims-view" aria-label="Simulators">
    <header className="sims-bar">
      <h2>Simulators</h2>
      <span className="sims-pill">{sims.length} booted</span>
      <span className="sims-pill warn">{sims.filter((sim) => sim.slim === 'unslimmed').length} unslimmed</span>
    </header>
    {error ? <p className="sims-error" role="alert">{error}</p> : null}
    {!loaded && !error ? <p className="sims-empty" role="status">Loading simulators…</p> : null}
    {loaded && !sims.length ? <p className="sims-empty">No booted iOS simulators.</p> : null}
    {liveUdid ? <div className="sims-live-overlay">
      <section className="sims-live-dialog" role="dialog" aria-modal="true" aria-label="Live simulator">
        <header><strong>{sims.find((sim) => sim.udid === liveUdid)?.lease?.sessionName ?? sims.find((sim) => sim.udid === liveUdid)?.name ?? 'Simulator'}</strong>
          <div className="sims-actions"><button type="button" autoFocus onClick={closeLive}>Close live view</button></div>
        </header>
        <SimLiveView key={liveUdid} udid={liveUdid} token={token} api={api} />
      </section>
    </div> : null}
    {ordered.map(([key, group]) => <section className="sims-group" key={key} aria-label={group.name}>
      <header className="sims-repo"><h3>{group.name}</h3><span>{group.sims.length} {key === 'no-lease' ? 'unleased' : 'leased'}</span></header>
      <div className="sims-grid">{group.sims.map((sim) => <SimCard key={sim.udid} sim={sim} api={api} visible={visible && liveUdid !== sim.udid} onLive={(trigger) => { liveTrigger.current = trigger; setLiveUdid(sim.udid) }} onSlimmed={() => setRevision((value) => value + 1)} />)}</div>
    </section>)}
  </section>
}
