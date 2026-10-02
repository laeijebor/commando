import { useEffect, useMemo, useRef, useState } from 'react'
import type { SimWallDevice } from '../shared/protocol'
import { cacheSims, createSimsApi, readCachedSims, simsCache, type CachedSimSnapshot } from './simsApi'
import './sims-view.css'
import { SimLiveView } from './SimLiveView'

type SimsApi = ReturnType<typeof createSimsApi>
type ViewPreferences = { groupBy: 'repo' | 'session' | 'none'; size: 's' | 'm' | 'l' }
const VIEW_STORAGE_KEY = 'commando.sims-view'
const DEFAULT_VIEW: ViewPreferences = { groupBy: 'repo', size: 'm' }

function snapshotAge(at: number, now: number): string | undefined {
  const seconds = Math.floor((now - at) / 1000)
  if (now - at <= 15_000) return
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`
}

function readViewPreferences(): ViewPreferences {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return DEFAULT_VIEW
    const groupBy = 'groupBy' in stored ? stored.groupBy : undefined
    const size = 'size' in stored ? stored.size : undefined
    return {
      groupBy: groupBy === 'repo' || groupBy === 'session' || groupBy === 'none' ? groupBy : DEFAULT_VIEW.groupBy,
      size: size === 's' || size === 'm' || size === 'l' ? size : DEFAULT_VIEW.size,
    }
  } catch { return DEFAULT_VIEW }
}

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
  const actionBusy = useRef(false)
  const [intersecting, setIntersecting] = useState(false)
  const [image, setImage] = useState<CachedSimSnapshot | undefined>(() => simsCache.snapshots.get(sim.udid))
  const displayed = useRef(image)
  const [now, setNow] = useState(Date.now)
  const [snapshotError, setSnapshotError] = useState('')
  const [error, setError] = useState('')
  const [action, setAction] = useState<'slim' | 'open' | null>(null)
  const name = sim.lease?.sessionName ?? sim.name

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting))
    if (card.current) observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    displayed.current = image
    return () => {
      if (image && simsCache.snapshots.get(sim.udid)?.url !== image.url) URL.revokeObjectURL(image.url)
    }
  }, [image, sim.udid])

  useEffect(() => {
    if (!visible || !image) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [visible, image])

  useEffect(() => {
    if (!visible || !intersecting) return
    const controller = new AbortController()
    // Scoped to this effect run: an aborted run must not block the next run's first fetch.
    let busy = false
    const refresh = async () => {
      if (busy || controller.signal.aborted || document.visibilityState !== 'visible') return
      busy = true
      let next: string | undefined
      try {
        const { blob, at } = await api.snapshotFrame(sim.udid, controller.signal)
        if (controller.signal.aborted) return
        const cached = simsCache.snapshots.get(sim.udid)
        if (cached && cached.at >= at) { setSnapshotError(''); return }
        next = URL.createObjectURL(blob)
        await loadImage(next, controller.signal)
        if (controller.signal.aborted || !simsCache.listing?.some((device) => device.udid === sim.udid)) return
        const frame = { url: next, at }
        const previous = simsCache.snapshots.get(sim.udid)
        if (previous && previous.url !== displayed.current?.url) URL.revokeObjectURL(previous.url)
        simsCache.snapshots.set(sim.udid, frame)
        setImage(frame)
        next = undefined // The module cache owns loaded URLs across remounts.
        setSnapshotError('')
      } catch (cause) {
        if (!controller.signal.aborted) setSnapshotError(cause instanceof Error ? cause.message : 'Snapshot unavailable')
      } finally {
        if (next) URL.revokeObjectURL(next)
        busy = false
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
      {image ? <img src={image.url} alt={`${name} snapshot`} />
        : <span className="sims-placeholder">{snapshotError || 'Waiting for snapshot…'}</span>}
      {image && snapshotAge(image.at, now) ? <span className="sims-snapshot-age">{snapshotAge(image.at, now)}</span> : null}
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
  const [view, setView] = useState(readViewPreferences)
  const [sessionFilter, setSessionFilter] = useState('all')
  const updateView = (next: ViewPreferences) => {
    setView(next)
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(next)) } catch { /* Storage may be unavailable. */ }
  }
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
  const [sims, setSims] = useState<SimWallDevice[]>(() => readCachedSims() ?? [])
  const [loaded, setLoaded] = useState(() => readCachedSims() !== undefined)
  const [updating, setUpdating] = useState(visible)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    if (!visible) { setUpdating(false); return }
    const controller = new AbortController()
    setUpdating(true)
    let busy = false
    let followUp: number | undefined
    let followUps = 0
    const refresh = async () => {
      if (busy || controller.signal.aborted || document.visibilityState !== 'visible') return
      busy = true
      let stale = false
      try {
        const next = await api.listing(controller.signal)
        if (controller.signal.aborted) return
        cacheSims(next.sims); setSims(next.sims); setLoaded(true); setError('')
        // A cached answer means the daemon is refreshing: ask again shortly rather than at the next poll.
        stale = next.stale && followUps < 8
        if (stale) { followUps += 1; followUp = window.setTimeout(() => void refresh(), 1_000) } else followUps = 0
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Simulators unavailable')
      } finally { busy = false; if (!controller.signal.aborted) setUpdating(stale) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => { window.clearInterval(timer); window.clearTimeout(followUp); controller.abort() }
  }, [api, visible, revision])

  const sessions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const sim of sims) {
      if (sim.lease) counts.set(sim.lease.sessionName, (counts.get(sim.lease.sessionName) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [sims])
  const unleased = sims.filter((sim) => !sim.lease)
  const filterExists = sessionFilter === 'all' || (sessionFilter === 'no-lease'
    ? unleased.length > 0 : sessions.some(([name]) => `session:${name}` === sessionFilter))
  const activeFilter = filterExists ? sessionFilter : 'all'
  useEffect(() => {
    if (!filterExists) setSessionFilter('all')
  }, [filterExists])
  const filtered = sims.filter((sim) => activeFilter === 'all' || (activeFilter === 'no-lease'
    ? !sim.lease : sim.lease && `session:${sim.lease.sessionName}` === activeFilter))
  const leased = filtered.filter((sim) => sim.lease)
  const filteredUnleased = filtered.filter((sim) => !sim.lease)
  type SimGroup = { key: string; name?: string; sims: SimWallDevice[] }
  let ordered: SimGroup[]
  if (view.groupBy === 'none') {
    ordered = filtered.length ? [{ key: 'flat', sims: [...leased, ...filteredUnleased] }] : []
  } else {
    const groups = new Map<string, SimGroup>()
    for (const sim of leased) {
      const lease = sim.lease!
      const key = view.groupBy === 'session' ? `session:${lease.sessionName}` : `repo:${lease.repo?.root ?? ''}`
      const name = view.groupBy === 'session' ? lease.sessionName : lease.repo?.name ?? 'Unknown repository'
      const group = groups.get(key) ?? { key, name, sims: [] }
      group.sims.push(sim)
      groups.set(key, group)
    }
    ordered = [...groups.values()].sort((a, b) => a.name!.localeCompare(b.name!))
    if (filteredUnleased.length) ordered.push({ key: 'no-lease', name: 'No lease', sims: filteredUnleased })
  }

  return <section className={`sims-view sims-size-${view.size}`} aria-label="Simulators">
    <header className="sims-bar">
      <h2>Simulators</h2>
      <span className="sims-pill">{sims.length} booted</span>
      <span className="sims-pill warn">{sims.filter((sim) => sim.slim === 'unslimmed').length} unslimmed</span>
      {loaded && updating ? <span className="sims-updating" role="status">Updating…</span> : null}
      <div className="sims-filters" role="group" aria-label="Filter simulators by session">
        <button type="button" className="sims-pill" aria-pressed={activeFilter === 'all'} onClick={() => setSessionFilter('all')}>All</button>
        {sessions.map(([name, count]) => <button type="button" className="sims-pill" key={name} aria-pressed={activeFilter === `session:${name}`} onClick={() => setSessionFilter(`session:${name}`)}>{name} ({count})</button>)}
        {unleased.length ? <button type="button" className="sims-pill" aria-pressed={activeFilter === 'no-lease'} onClick={() => setSessionFilter('no-lease')}>No lease ({unleased.length})</button> : null}
      </div>
      <div className="sims-layout-control" role="group" aria-label="Group by">
        <span>Group by</span>
        <div className="sims-segmented">
          {(['repo', 'session', 'none'] as const).map((groupBy) => <button type="button" key={groupBy} aria-pressed={view.groupBy === groupBy} onClick={() => updateView({ ...view, groupBy })}>{groupBy === 'repo' ? 'Repo' : groupBy === 'session' ? 'Session' : 'None'}</button>)}
        </div>
      </div>
      <div className="sims-layout-control" role="group" aria-label="Size">
        <span>Size</span>
        <div className="sims-segmented">
          {(['s', 'm', 'l'] as const).map((size) => <button type="button" key={size} aria-pressed={view.size === size} onClick={() => updateView({ ...view, size })}>{size.toUpperCase()}</button>)}
        </div>
      </div>
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
    {ordered.map((group) => <section className="sims-group" key={group.key} aria-label={group.name}>
      {group.name !== undefined ? <header className="sims-repo"><h3>{group.name}</h3><span>{group.sims.length} {group.key === 'no-lease' ? 'unleased' : 'leased'}</span></header> : null}
      <div className="sims-grid">{group.sims.map((sim) => <SimCard key={sim.udid} sim={sim} api={api} visible={visible && liveUdid !== sim.udid} onLive={(trigger) => { liveTrigger.current = trigger; setLiveUdid(sim.udid) }} onSlimmed={() => setRevision((value) => value + 1)} />)}</div>
    </section>)}
  </section>
}
