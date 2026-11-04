import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { RemoteHost } from '../shared/hosts'
import { useHost } from './HostContext'
import { createHostsApi } from './hostsApi'
import './session-create-dialog.css'
import './hosts.css'

export function HostSwitcher({ token, authenticated = true }: { token: string; authenticated?: boolean }) {
  const { activeHost, hosts, setHosts, switchHost } = useHost()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    const api = createHostsApi(token)
    const refresh = async () => {
      try { const hosts = await api.list(); if (!cancelled) { setHosts(hosts); setError('') } }
      catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load hosts') }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [token, authenticated, setHosts])
  return <div className="host-switcher">
    <label className="section-kicker" htmlFor="active-host">Machine</label>
    <select id="active-host" aria-label="Active host" value={activeHost} onChange={(event) => {
      if (event.target.value === '__add') setAdding(true)
      else switchHost(event.target.value)
    }}>
      <option value="local">● This Mac</option>
      {activeHost !== 'local' && !hosts.some((host) => host.id === activeHost) ? <option value={activeHost}>○ {activeHost} · unavailable</option> : null}
      {hosts.map((host) => <option key={host.id} value={host.id}>{host.health.state === 'online' ? '●' : host.health.state === 'unauthorized' ? '◐' : '○'} {host.name} · {host.health.state}</option>)}
      <option value="__add">Add host…</option>
    </select>
    <div className="host-health-list" aria-label="Host health">
      {hosts.map((host) => <span key={host.id} title={`${host.name}: ${host.health.state}`}><i data-health={host.health.state} />{host.name}: {host.health.state}</span>)}
    </div>
    {error ? <small role="alert">{error}</small> : null}
    {adding ? <HostDialog token={token} onClose={() => setAdding(false)} /> : null}
  </div>
}

export function HostDialog({ token, host, onClose }: { token: string; host?: RemoteHost; onClose: () => void }) {
  const { setHosts, activeHost, reconnectHost } = useHost()
  const [name, setName] = useState(host?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(host?.baseUrl ?? '')
  const [credential, setCredential] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    setPending(true); setError('')
    try {
      const api = createHostsApi(token)
      const saved = host ? await api.update(host.id, { name, ...(credential ? { token: credential } : {}) }) : await api.add({ name, baseUrl, token: credential })
      setCredential('')
      setHosts((current) => host ? current.map((entry) => entry.id === saved.id ? saved : entry) : [...current.filter((entry) => entry.id !== saved.id), saved])
      if (host?.id === activeHost && credential) reconnectHost()
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save host') }
    finally { setPending(false) }
  }
  return <div className="session-create-backdrop" data-native-terminal-occluder="" onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose() }}>
    <section className="session-create-dialog host-dialog" role="dialog" aria-modal="true" aria-labelledby="host-dialog-title" aria-busy={pending} onKeyDown={(event) => {
      if (event.key === 'Escape' && !pending) { event.stopPropagation(); onClose() }
    }}>
      <header><strong id="host-dialog-title">{host ? 'Edit host' : 'Add host'}</strong><button type="button" onClick={onClose} disabled={pending} aria-label="Close">×</button></header>
      <form onSubmit={(event) => void submit(event)}>
        <label>Name<input ref={nameRef} required value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></label>
        <label>URL<input type="url" required value={baseUrl} placeholder="http://hub.example.ts.net:4310" onChange={(event) => setBaseUrl(event.target.value)} disabled={pending || Boolean(host)} /></label>
        <label>{host ? 'Replace token (leave blank to keep)' : 'Token'}<input type="password" autoComplete="off" required={!host} value={credential} onChange={(event) => setCredential(event.target.value)} disabled={pending} /></label>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <button type="submit" disabled={pending}>{pending ? 'Checking…' : host ? 'Save host' : 'Add host'}</button>
      </form>
    </section>
  </div>
}

export function HostsSettings({ token }: { token: string }) {
  const { hosts, setHosts, activeHost, switchHost } = useHost()
  const [editing, setEditing] = useState<RemoteHost | 'add' | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const api = useMemo(() => createHostsApi(token), [token])
  const remove = async (host: RemoteHost) => {
    if (!window.confirm(`Remove ${host.name}?`)) return
    setPending(true); setError('')
    try {
      await api.remove(host.id)
      setHosts((current) => current.filter((entry) => entry.id !== host.id))
      if (activeHost === host.id) switchHost('local')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove host') }
    finally { setPending(false) }
  }
  return <section className="settings-section" aria-label="Hosts">
    <h3>Hosts</h3><p className="settings-hint">Hosts are registered on This Mac. Sessions start on the host you are viewing.</p>
    {hosts.map((host) => <div className="host-settings-row" key={host.id}>
      <span><i data-health={host.health.state} />{host.name} · {host.health.state}<small>{host.baseUrl}</small></span>
      <button className="settings-button" disabled={pending} onClick={() => setEditing(host)}>Edit</button>
      <button className="settings-button" disabled={pending} onClick={() => void remove(host)}>Remove</button>
    </div>)}
    <button className="settings-button" onClick={() => setEditing('add')}>Add host…</button>
    {error ? <p role="alert">{error}</p> : null}
    {editing ? <HostDialog token={token} host={editing === 'add' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
  </section>
}

