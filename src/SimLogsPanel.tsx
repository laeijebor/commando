import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { SIM_BUNDLE_ID, type SimApp, type SimLogLevel, type SimLogLine } from '../shared/sim-actions'
import type { SimsApiClient } from './simsApi'

type Entry = SimLogLine & { id: number }
export const simLogText = (line: SimLogLine) => [line.t, line.level, line.process, line.subsystem, line.category, line.message].filter(Boolean).join(' ')
const LogRow = memo(function LogRow({ line }: { line: Entry }) {
  return <div className={`sim-log-line${/^(error|fault)$/i.test(line.level) ? ' is-error' : ''}`}>
    <span>{[line.t, line.level, line.process.split('/').at(-1), line.subsystem, line.category].filter(Boolean).join(' · ')}</span>
    <pre>{line.message}</pre>
  </div>
})

export function SimLogsPanel({ api, udid, token, onClose }: { api: SimsApiClient; udid: string; token: string; onClose: () => void }) {
  const [level, setLevel] = useState<SimLogLevel>('info')
  const [bundle, setBundle] = useState('')
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [lines, setLines] = useState<Entry[]>([])
  const [apps, setApps] = useState<SimApp[]>([])
  const [error, setError] = useState('')
  const [appsError, setAppsError] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const buffer = useRef<Entry[]>([])
  const dirty = useRef(false)
  const nextId = useRef(0)
  const pause = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const appsId = useId()
  useEffect(() => {
    const controller = new AbortController()
    void api.apps(udid, controller.signal).then((apps) => { if (!controller.signal.aborted) setApps(apps) }).catch((error: unknown) => {
      if (!controller.signal.aborted) setAppsError(error instanceof Error ? error.message : 'Unable to load apps')
    })
    return () => controller.abort()
  }, [api, udid])
  useEffect(() => {
    setError('')
    if (bundle && !SIM_BUNDLE_ID.test(bundle)) { setError('Enter a valid app bundle id'); return }
    let socket: WebSocket
    try {
      const url = new URL(`/ws/api/sims/${encodeURIComponent(udid)}/logs`, window.location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('level', level)
      if (bundle) url.searchParams.set('bundle', bundle)
      const credential = encodeURIComponent(token).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
      socket = new WebSocket(url.toString(), token ? ['commando-live', `commando-auth.${credential}`] : ['commando-live'])
    } catch { setError('Simulator logs connection unavailable'); return }
    socket.onmessage = (event) => {
      if (pause.current || typeof event.data !== 'string') return
      let line: unknown
      try { line = JSON.parse(event.data) } catch { return }
      if (!line || typeof line !== 'object' || !('message' in line) || typeof line.message !== 'string') return
      const entry = line as SimLogLine
      if (typeof entry.t !== 'string' || typeof entry.level !== 'string' || typeof entry.process !== 'string'
        || (entry.subsystem !== undefined && typeof entry.subsystem !== 'string') || (entry.category !== undefined && typeof entry.category !== 'string')) return
      buffer.current.push({ ...entry, message: entry.message.slice(0, 4000), id: nextId.current++ })
      if (buffer.current.length > 2000) buffer.current.shift()
      dirty.current = true
    }
    socket.onerror = () => setError('Simulator logs connection failed')
    socket.onclose = (event) => setError(event.reason || 'Simulator log stream closed')
    const timer = setInterval(() => {
      if (!dirty.current) return
      dirty.current = false; setLines(buffer.current.slice())
    }, 100)
    return () => {
      clearInterval(timer)
      socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close()
    }
  }, [udid, token, level, bundle])
  const visible = useMemo(() => {
    const query = filter.toLowerCase()
    return query ? lines.filter((line) => simLogText(line).toLowerCase().includes(query)) : lines
  }, [lines, filter])
  useLayoutEffect(() => { if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight }, [visible])
  const copy = async () => {
    try { await navigator.clipboard.writeText(visible.map(simLogText).join('\n')); setCopyStatus('Copied') }
    catch { setCopyStatus('Copy failed') }
  }
  return <aside className="sim-inspector-panel sim-logs-panel" aria-label="Simulator logs">
    <header><strong>Logs</strong><button type="button" aria-label="Close logs" onClick={onClose}><X aria-hidden="true" /></button></header>
    <div className="sim-panel-controls">
      <label>Level<select value={level} onChange={(event) => setLevel(event.target.value as SimLogLevel)}>
        {(['default', 'info', 'debug'] as const).map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>App filter<input value={bundle} list={appsId} placeholder="All apps" onChange={(event) => setBundle(event.target.value)} /></label>
      <datalist id={appsId}>{apps.filter((app) => app.type === 'user').map((app) => <option key={app.bundleId} value={app.bundleId}>{app.name}</option>)}</datalist>
      <label>Text filter<input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <div className="sim-panel-buttons">
        <button type="button" onClick={() => { pause.current = !pause.current; buffer.current = lines.slice(); dirty.current = false; setPaused(pause.current) }}>{paused ? 'Resume' : 'Pause'}</button>
        <button type="button" onClick={() => { buffer.current = []; dirty.current = false; setLines([]); setCopyStatus('') }}>Clear</button>
        <button type="button" onClick={() => void copy()}>Copy visible</button>
      </div>
    </div>
    {error || appsError ? <p className="sims-error" role="alert">{error || appsError}</p> : null}
    {copyStatus ? <p role="status">{copyStatus}</p> : null}
    <p className="sim-panel-note">{visible.length} visible · {lines.length} / 2000 lines{paused ? ' · Paused (incoming lines discarded)' : ''}</p>
    <div ref={list} className="sim-log-list" aria-label="Log lines" onScroll={(event) => {
      const target = event.currentTarget
      atBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 16
    }}>{visible.map((line) => <LogRow key={line.id} line={line} />)}</div>
  </aside>
}
