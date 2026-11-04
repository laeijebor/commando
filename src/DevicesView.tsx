import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import './sims-view.css'
import './devices-view.css'

type Resource = { id: string; name: string; kind: 'android' | 'ios' | 'emulator' | 'host'; serial?: string; release?: string; busyProcesses?: string[] }
type Owner = { paneId: string; sessionName: string; as?: string; pid?: number }
type Holder = Owner & { resourceId: string; task: string; estimateMs?: number; acquiredAt: number }
type Entry = Owner & {
  id: string; request: string; resourceIds: string[]; task: string; estimateMs?: number; mode: 'notify' | 'wait'; enqueuedAt: number; position: number
  offer?: { resourceId: string; at: number; deliveredAt?: number }
  /** When the offer lapses (from the server, which owns the claim window). */
  claimBy?: number
}
export type DevicesSnapshot = {
  resources: Resource[]; holders: Holder[]; queue: Entry[]; paused: string[]; now: number
  waitingFor: Record<string, string>; connections: Record<string, 'connected' | 'missing' | 'unknown' | 'no-serial'>; idleSince: Record<string, number>
}
/** Runs a Devices action; resolves when it settled (the view applies the newest answer). */
type Run = (work: () => Promise<DevicesSnapshot>) => Promise<void>

const IDLE_FLAG_MS = 10 * 60_000

export function createDevicesApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async (path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<DevicesSnapshot> => {
    const response = await fetcher(`/api/devices${path}`, {
      method, signal, credentials: 'same-origin', cache: 'no-store',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const payload = await response.json().catch(() => null) as (DevicesSnapshot & { error?: string }) | null
    if (!response.ok || !payload) throw new Error(payload?.error ?? `Device request failed (${response.status})`)
    return payload
  }
  return {
    list: (signal?: AbortSignal) => request('', 'GET', undefined, signal),
    pause: (id: string, paused: boolean) => request(`/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, 'POST'),
    release: (id: string) => request(`/${encodeURIComponent(id)}/release`, 'POST'),
    move: (entryId: string, before?: string) => request(`/queue/${encodeURIComponent(entryId)}/move`, 'POST', before ? { before } : {}),
    remove: (entryId: string) => request(`/queue/${encodeURIComponent(entryId)}`, 'DELETE'),
  }
}
type DevicesApi = ReturnType<typeof createDevicesApi>

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1_440)}d`
}

const who = (owner: Owner) => owner.as ?? owner.sessionName

/** Why a holder needs the user's attention, if it does. */
export function holderFlag(holder: Holder, now: number, idleSince?: number): { tone: 'amber' | 'red'; text: string } | undefined {
  const held = now - holder.acquiredAt
  if (holder.estimateMs && held >= 3 * holder.estimateMs) return { tone: 'red', text: `${duration(held)} held · est. ${duration(holder.estimateMs)}` }
  // A script holds the lock for its own run, whatever the agent in its pane is doing.
  if (!holder.pid && idleSince !== undefined && now - idleSince >= IDLE_FLAG_MS) return { tone: 'amber', text: `agent idle ${duration(now - idleSince)}` }
  if (holder.estimateMs && held > holder.estimateMs) return { tone: 'amber', text: `over estimate by ${duration(held - holder.estimateMs)}` }
  return undefined
}

function DeviceCard({ resource, snapshot, api, run, onOpenPane }: {
  resource: Resource; snapshot: DevicesSnapshot; api: DevicesApi; run: Run; onOpenPane?: (paneId: string) => void
}) {
  const [busy, setBusy] = useState(false)
  // Refs carry the drag between events; state only paints it. A fast drag can drop before React re-renders.
  const drag = useRef<{ id?: string; before?: string | null }>({})
  const [dragging, setDragging] = useState<string>()
  const [dropBefore, setDropBefore] = useState<string | null>()
  const endDrag = () => { drag.current = {}; setDragging(undefined); setDropBefore(undefined) }
  const now = snapshot.now
  const holders = snapshot.holders.filter((holder) => holder.resourceId === resource.id)
  const queue = snapshot.queue.filter((entry) => entry.resourceIds.includes(resource.id))
  const offered = queue.find((entry) => entry.offer?.resourceId === resource.id)
  // A request offered another device isn't waiting for this one.
  const waiting = queue.filter((entry) => !entry.offer)
  const paused = snapshot.paused.includes(resource.id)
  const connection = snapshot.connections[resource.id] ?? 'unknown'
  const flags = holders.map((holder) => holderFlag(holder, now, snapshot.idleSince[holder.paneId]))
  const state = paused ? 'paused' : holders.length ? (flags.some((flag) => flag?.tone === 'red') ? 'stale' : 'held') : offered ? 'offered' : 'free'
  const act = (work: () => Promise<DevicesSnapshot>) => {
    if (busy) return
    setBusy(true)
    void run(work).finally(() => setBusy(false))
  }

  const drop = (event: DragEvent) => {
    event.preventDefault()
    const { id, before } = drag.current
    endDrag()
    if (!id || before === id || before === undefined) return
    // Below this card's last request: go before whatever follows it in the shared queue, not to the very end,
    // so a request that also waits for other devices keeps its place there.
    const last = waiting.at(-1)!
    const after = before ?? snapshot.queue.slice(snapshot.queue.findIndex((entry) => entry.id === last.id) + 1).find((entry) => entry.id !== id)?.id
    if (before === null && last.id === id) return
    act(() => api.move(id, after))
  }
  const sub = [resource.kind === 'host' ? 'Mac' : resource.kind === 'emulator' ? 'Emulator' : resource.kind === 'ios' ? 'iOS' : 'Android',
    resource.kind === 'host' ? (resource.busyProcesses?.length ? 'waits for builds' : '') : connection === 'connected' ? 'connected' : connection === 'missing' ? 'not connected' : connection === 'no-serial' ? 'no serial set' : 'checking…',
    resource.serial ?? ''].filter(Boolean).join(' · ')

  return <article className={`devices-card${connection === 'missing' ? ' missing' : ''}`} aria-label={resource.name} aria-busy={busy}>
    <header className="devices-head">
      <span className={`devices-glyph${resource.kind === 'host' ? ' host' : ''}`} aria-hidden="true" />
      <div className="devices-title"><div className="devices-name">{resource.name}</div><div className="devices-sub">{sub}</div></div>
      <span className={`sims-pill devices-state ${state}`}>{state}</span>
    </header>

    {holders.map((holder, index) => <section key={`${holder.paneId}:${holder.as ?? ''}`} className={`devices-holder${flags[index]?.tone === 'red' ? ' stale' : ''}`} aria-label={`Held by ${who(holder)}`}>
      <div className="devices-label">Holding <em>{duration(now - holder.acquiredAt)}</em></div>
      <div className="devices-who"><strong>{who(holder)}</strong>{holder.as ? <span className="devices-agent">{holder.sessionName}</span> : null}{holder.pid ? <span className="devices-tag">script · pid {holder.pid}</span> : null}</div>
      <div className="devices-task">{holder.task}</div>
      <div className="sims-meta">
        {holder.estimateMs ? <span>est. {duration(holder.estimateMs)}</span> : null}
        {flags[index] ? <span className={flags[index]!.tone === 'red' ? 'idle' : 'ended'}>{flags[index]!.text}</span> : null}
      </div>
      <div className="sims-actions">
        {onOpenPane ? <button type="button" onClick={() => onOpenPane(holder.paneId)}>Open pane</button> : null}
        <button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm(`Release ${resource.name} from ${who(holder)}? They will be told to stop using it.`)) act(() => api.release(resource.id)) }}>Release</button>
      </div>
    </section>)}

    {offered ? <section className="devices-holder offered" aria-label={`Offered to ${who(offered)}`}>
      <div className="devices-label">Next up <em>offered {duration(now - offered.offer!.at)} ago</em></div>
      <div className="devices-who"><strong>{who(offered)}</strong>{offered.as ? <span className="devices-agent">{offered.sessionName}</span> : null}</div>
      <div className="devices-task">{offered.task}</div>
      <div className="sims-meta"><span className="ended">{offered.offer!.deliveredAt === undefined ? 'message not delivered yet · lapses in ' : 'must claim within '}
        {duration(Math.max(0, (offered.claimBy ?? now) - now) + 59_999)}</span></div>
      <div className="sims-actions">
        {onOpenPane ? <button type="button" onClick={() => onOpenPane(offered.paneId)}>Open pane</button> : null}
        <button type="button" disabled={busy} onClick={() => act(() => api.remove(offered.id))}>Skip to next</button>
      </div>
    </section> : null}

    {snapshot.waitingFor[resource.id] && !holders.length && waiting.length ? <p className="devices-busy">Waiting for {snapshot.waitingFor[resource.id]} to finish</p> : null}

    {waiting.length ? <>
      <div className="devices-label">Queue {waiting.length > 1 ? <em>drag to reorder</em> : null}</div>
      <ol className="devices-queue" onDragOver={(event) => { if (drag.current.id) event.preventDefault() }} onDrop={drop}>
        {waiting.map((entry, index) => <li key={entry.id}
          className={`devices-entry${dragging === entry.id ? ' dragging' : ''}${dropBefore === entry.id && dragging !== entry.id ? ' drop-before' : ''}`}
          draggable onDragStart={(event) => { drag.current = { id: entry.id }; setDragging(entry.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', entry.id) }}
          onDragEnd={endDrag}
          onDragOver={(event) => {
            if (!drag.current.id) return
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            const before = event.clientY < box.top + box.height / 2 ? entry.id : waiting[index + 1]?.id ?? null
            drag.current.before = before
            setDropBefore(before)
          }}>
          <span className="devices-grip" aria-hidden="true">⋮⋮</span>
          <span className="devices-pos">{index + 1}</span>
          <div className="devices-entry-main">
            <div className="devices-who"><strong>{who(entry)}</strong>{entry.mode === 'wait' ? <span className="devices-tag">script · waiting</span> : null}{entry.request !== resource.id ? <span className="devices-tag">{entry.request}</span> : null}</div>
            <div className="devices-task">{entry.task}</div>
          </div>
          <div className="devices-entry-side">waiting {duration(now - entry.enqueuedAt)}{entry.estimateMs ? <span>est. {duration(entry.estimateMs)}</span> : null}</div>
          <div className="devices-entry-actions sims-actions">
            {index > 0 ? <button type="button" disabled={busy} aria-label={`Move ${who(entry)} up`} onClick={() => act(() => api.move(entry.id, waiting[index - 1].id))}>↑</button> : null}
            <button type="button" disabled={busy} aria-label={`Remove ${who(entry)} from the queue`} onClick={() => act(() => api.remove(entry.id))}>✕</button>
          </div>
        </li>)}
      </ol>
    </> : !holders.length && !offered ? <p className="devices-empty">Free. No one waiting.</p> : null}

    {resource.release ? <p className="devices-release">On release: {resource.release}</p> : null}
    <div className="sims-actions">
      <button type="button" disabled={busy} aria-pressed={paused} onClick={() => act(() => api.pause(resource.id, !paused))}>{paused ? 'Resume queue' : 'Pause queue (I’m using it)'}</button>
    </div>
  </article>
}

export function DevicesView({ token, onOpenPane, api: injected }: { token: string; onOpenPane?: (paneId: string) => void; api?: DevicesApi }) {
  const api = useMemo(() => injected ?? createDevicesApi(token), [injected, token])
  const [snapshot, setSnapshot] = useState<DevicesSnapshot>()
  const [error, setError] = useState('')
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  // Polls and actions race; apply an answer only if no later-started request has been applied already.
  const issued = useRef(0), applied = useRef(0)
  const track = useCallback(async (work: () => Promise<DevicesSnapshot>, quiet = false) => {
    const sequence = ++issued.current
    try {
      const next = await work()
      if (sequence > applied.current) { applied.current = sequence; setSnapshot(next); setError('') }
    } catch (cause) {
      if (!quiet || sequence > applied.current) setError(cause instanceof Error ? cause.message : 'Device request failed')
    }
  }, [])
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', change)
    return () => document.removeEventListener('visibilitychange', change)
  }, [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let polling = false
    const refresh = () => {
      if (polling) return
      polling = true
      void track(() => api.list(controller.signal), true).finally(() => { polling = false })
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [api, visible, track])

  const held = snapshot?.resources.filter((resource) => snapshot.holders.some((holder) => holder.resourceId === resource.id)).length ?? 0
  const stale = snapshot?.holders.filter((holder) => holderFlag(holder, snapshot.now, snapshot.idleSince[holder.paneId])?.tone === 'red').length ?? 0
  return <section className="sims-view devices-view" aria-label="Devices">
    <header className="sims-bar">
      <h2>Devices</h2>
      {snapshot ? <>
        <span className="sims-pill">{snapshot.resources.length} locks</span>
        <span className="sims-pill">{held} held</span>
        {snapshot.queue.length ? <span className="sims-pill warn">{snapshot.queue.length} waiting</span> : null}
        {stale ? <span className="sims-pill bad">{stale} stale</span> : null}
      </> : null}
    </header>
    {error ? <p className="sims-error" role="alert">{error}</p> : null}
    {!snapshot && !error ? <p className="sims-empty" role="status">Loading devices…</p> : null}
    {snapshot && !snapshot.resources.length ? <p className="sims-empty">No device locks yet. An agent can add one with <code>commando-device.mjs resource add pixel --name "Pixel 5" --kind android --serial &lt;adb serial&gt;</code>.</p> : null}
    {snapshot ? <div className="devices-grid">{snapshot.resources.map((resource) => <DeviceCard key={resource.id} resource={resource} snapshot={snapshot} api={api} run={track} onOpenPane={onOpenPane} />)}</div> : null}
  </section>
}
