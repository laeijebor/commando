import { useEffect, useMemo, useRef, useState } from 'react'
import type { SimPoolSummary, SimWallDevice } from '../shared/protocol'
import { cacheSimSnapshot, claimSimSnapshotPolling, subscribeSimSnapshot, cacheSims, createSimsApi, readCachedSims, simsCache, type CachedSimSnapshot } from './simsApi'
import './sims-view.css'
import { SimLiveView } from './SimLiveView'

type SimsApi = ReturnType<typeof createSimsApi>
type ViewPreferences = { groupBy: 'repo' | 'session' | 'none'; size: 's' | 'm' | 'l' }
const VIEW_STORAGE_KEY = 'commando.sims-view'
const DEFAULT_VIEW: ViewPreferences = { groupBy: 'repo', size: 'm' }

const HOVER_ARM_MS = 1_000
const HOVER_IDLE_MS = 30_000

function snapshotAge(at: number, now: number): string | undefined {
  const seconds = Math.floor((now - at) / 1000)
  if (now - at <= 15_000) return
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`
}

function endedAge(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  return minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
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

function SimCard({ sim, api, token, visible, formerGroup, showEnded, hover, onHover, onSlimmed, onLive }: {
  sim: SimWallDevice; api: SimsApi; token: string; visible: boolean; formerGroup: boolean; showEnded: boolean
  hover: 'arming' | 'live' | undefined; onHover: (hovered: boolean) => void; onSlimmed: () => void; onLive: (trigger: HTMLButtonElement) => void
}) {
  const card = useRef<HTMLElement>(null)
  const actionBusy = useRef(false)
  const [intersecting, setIntersecting] = useState(false)
  const [image, setImage] = useState<CachedSimSnapshot | undefined>(() => simsCache.snapshots.get(sim.udid))
  const [now, setNow] = useState(Date.now)
  const [snapshotError, setSnapshotError] = useState('')
  const [error, setError] = useState('')
  const [action, setAction] = useState<'slim' | 'open' | null>(null)
  const [streaming, setStreaming] = useState(false)
  const ended = !sim.lease ? sim.endedLease : undefined
  const name = sim.lease?.sessionName ?? (formerGroup ? ended?.sessionName : undefined) ?? sim.name

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting))
    if (card.current) observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => subscribeSimSnapshot(sim.udid, setImage), [sim.udid])

  useEffect(() => {
    if (!visible || (!image && !ended)) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [visible, image, ended])

  useEffect(() => {
    if (!visible || !intersecting) return
    return claimSimSnapshotPolling(sim.udid, () => {
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
          cacheSimSnapshot(sim.udid, frame)
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
    })
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
    <div className="sims-snapshot" onPointerEnter={(event) => { if (event.pointerType === 'mouse') onHover(true) }} onPointerLeave={() => onHover(false)}>
      <button type="button" className="sims-snapshot-control" onClick={(event) => { if (hover !== 'live' || !streaming) onLive(event.currentTarget) }} aria-label={`View ${name} live`}>
        {image ? <img src={image.url} alt={`${name} snapshot`} />
          : <span className="sims-placeholder">{snapshotError || 'Waiting for snapshot…'}</span>}
      </button>
      {/* The live canvas sits over the snapshot, which stays visible until video arrives or if it cannot start. */}
      {hover === 'live' && visible ? <SimLiveView udid={sim.udid} token={token} api={api} preview onStreaming={setStreaming} /> : null}
      {hover === 'arming' ? <span className="sims-hover-ring" aria-hidden="true"><svg viewBox="0 0 22 22"><circle cx="11" cy="11" r="8" /></svg></span> : null}
      {streaming ? <span className="sims-snapshot-live">live</span>
        : image && snapshotAge(image.at, now) ? <span className="sims-snapshot-age">{snapshotAge(image.at, now)}</span> : null}
      <button type="button" className="sims-expand" aria-label={`Open ${name} live view`} onClick={(event) => onLive(event.currentTarget)}>↗</button>
    </div>
    <div className="sims-name">{name}</div>
    <div className="sims-task">{sim.lease?.task || (sim.lease ? 'No task' : formerGroup && ended ? ended.task || 'No task' : 'No lease')}</div>
    {ended && !formerGroup ? <div className="sims-last">last: {ended.sessionName}{ended.task ? ` · ${ended.task}` : ''}</div> : null}
    <div className="sims-meta">
      {sim.pool ? <span className="pool" title={sim.poolProjects?.length ? `used by: ${sim.poolProjects.join(', ')}` : undefined}>pool</span> : null}
      <span className={sim.slim}>{sim.slim === 'unknown' ? 'slim unknown' : sim.slim}</span>
      {ended && showEnded ? <><span className="ended">lease ended</span><span>ended {endedAge(ended.endedAt, now)}</span></> : null}
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
  // Resting the mouse on a card for HOVER_ARM_MS attaches its live stream in place. Only one card is
  // attached at a time, and it detaches HOVER_IDLE_MS after the mouse leaves unless it returns.
  const [hover, setHover] = useState<{ arming?: string; live?: string }>({})
  const hoverTimers = useRef<{ arm?: number; idle?: number }>({})
  // Cards are keyed by group and device: an ended simulator appears twice and only the hovered copy attaches.
  const onHover = (udid: string, hovered: boolean) => {
    window.clearTimeout(hoverTimers.current.arm)
    if (!hovered) {
      setHover((current) => ({ live: current.live }))
      if (hover.live !== udid) return
      window.clearTimeout(hoverTimers.current.idle)
      hoverTimers.current.idle = window.setTimeout(() => setHover((current) => ({ arming: current.arming })), HOVER_IDLE_MS)
      return
    }
    if (hover.live === udid) { window.clearTimeout(hoverTimers.current.idle); return }
    setHover((current) => ({ live: current.live, arming: udid }))
    hoverTimers.current.arm = window.setTimeout(() => {
      window.clearTimeout(hoverTimers.current.idle)
      setHover({ live: udid })
    }, HOVER_ARM_MS)
  }
  useEffect(() => () => { window.clearTimeout(hoverTimers.current.arm); window.clearTimeout(hoverTimers.current.idle) }, [])
  useEffect(() => {
    if (!liveUdid) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeLive() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [liveUdid])
  const [sims, setSims] = useState<SimWallDevice[]>(() => readCachedSims() ?? [])
  const [pool, setPool] = useState<SimPoolSummary | undefined>(() => simsCache.pool)
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
        cacheSims(next.sims, next.pool); setPool(next.pool); setSims(next.sims); setLoaded(true); setError('')
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
      const owner = sim.lease ?? sim.endedLease
      if (owner) counts.set(owner.sessionName, (counts.get(owner.sessionName) ?? 0) + 1)
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
    ? !sim.lease : (sim.lease ?? sim.endedLease) && `session:${(sim.lease ?? sim.endedLease)!.sessionName}` === activeFilter))
  const leased = filtered.filter((sim) => sim.lease)
  const filteredUnleased = filtered.filter((sim) => !sim.lease)
  type SimGroup = { key: string; name?: string; sims: SimWallDevice[] }
  let ordered: SimGroup[]
  if (view.groupBy === 'none') {
    ordered = filtered.length ? [{ key: 'flat', sims: [...leased, ...filteredUnleased] }] : []
  } else {
    const groups = new Map<string, SimGroup>()
    for (const sim of filtered.filter((device) => device.lease || device.endedLease)) {
      const lease = (sim.lease ?? sim.endedLease)!
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
      {pool && pool.size > 0 ? <span className="sims-pill">pool {pool.free} free / {pool.size}</span> : null}
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
      {group.name !== undefined ? <header className="sims-repo"><h3>{group.name}</h3><span>{group.key === 'no-lease' ? `${group.sims.length} unleased` : [
        group.sims.some((sim) => sim.lease) ? `${group.sims.filter((sim) => sim.lease).length} leased` : '',
        group.sims.some((sim) => !sim.lease && sim.endedLease) ? `${group.sims.filter((sim) => !sim.lease && sim.endedLease).length} ended` : '',
      ].filter(Boolean).join(' · ')}</span></header> : null}
      <div className="sims-grid">{group.sims.map((sim) => <SimCard key={sim.udid} sim={sim} api={api} token={token} hover={hover.live === `${group.key}:${sim.udid}` ? 'live' : hover.arming === `${group.key}:${sim.udid}` ? 'arming' : undefined} onHover={(hovered) => onHover(`${group.key}:${sim.udid}`, hovered)} formerGroup={group.key !== 'no-lease' && group.key !== 'flat'} showEnded={group.key !== 'no-lease'} visible={visible && liveUdid !== sim.udid} onLive={(trigger) => { liveTrigger.current = trigger; setLiveUdid(sim.udid) }} onSlimmed={() => setRevision((value) => value + 1)} />)}</div>
    </section>)}
  </section>
}
