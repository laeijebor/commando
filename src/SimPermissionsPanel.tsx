import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { SIM_PRIVACY_SERVICES, type SimAction, type SimApp, type SimPrivacyService } from '../shared/sim-actions'
import type { SimsApiClient } from './simsApi'

type Operation = Extract<SimAction, { action: 'privacy' }>['operation']
const labels: Record<Operation, string> = { grant: 'Granted', revoke: 'Denied', reset: 'Reset' }

export function SimPermissionsPanel({ api, udid, onClose }: { api: SimsApiClient; udid: string; onClose: () => void }) {
  const [apps, setApps] = useState<SimApp[]>([])
  const [bundleId, setBundleId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(new Set<string>())
  const [actions, setActions] = useState<Record<string, Operation>>({})
  const pending = useRef(new Set<string>())
  const revision = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    revision.current++; pending.current.clear(); setBusy(new Set()); setActions({}); setError(''); setLoading(true); setBundleId(''); setApps([])
    void api.apps(udid, controller.signal).then((apps) => { if (!controller.signal.aborted) { setApps(apps); setBundleId(apps[0]?.bundleId ?? '') } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Unable to load apps') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); revision.current++ }
  }, [api, udid])
  const perform = async (service: SimPrivacyService, operation: Operation) => {
    const key = `${bundleId}:${service}`, all = `${bundleId}:all`
    if (!bundleId || pending.current.has(key) || pending.current.has(all) || (service === 'all' && [...pending.current].some((key) => key.startsWith(`${bundleId}:`)))) return
    const current = revision.current
    pending.current.add(key); setBusy(new Set(pending.current)); setError('')
    try {
      await api.action(udid, { action: 'privacy', operation, service, bundleId })
      if (current !== revision.current) return
      setActions((actions) => ({ ...actions, ...Object.fromEntries((service === 'all' ? SIM_PRIVACY_SERVICES : [service]).map((service) => [`${bundleId}:${service}`, operation])) }))
    } catch (error) { if (current === revision.current) setError(error instanceof Error ? error.message : 'Permission action failed') }
    finally { if (current === revision.current) { pending.current.delete(key); setBusy(new Set(pending.current)) } }
  }
  const appBusy = [...busy].some((key) => key.startsWith(`${bundleId}:`))
  return <aside className="sim-inspector-panel sim-permissions-panel" aria-label="App permissions">
    <header><strong>Permissions</strong><button type="button" aria-label="Close permissions" onClick={onClose}><X aria-hidden="true" /></button></header>
    <div className="sim-panel-controls"><label>App<select value={bundleId} disabled={loading || !apps.length} onChange={(event) => setBundleId(event.target.value)}>
      {!apps.length ? <option value="">{loading ? 'Loading apps…' : 'No installed apps'}</option> : null}
      {(['user', 'system'] as const).map((type) => <optgroup key={type} label={type === 'user' ? 'User apps' : 'System apps'}>
        {apps.filter((app) => app.type === type).map((app) => <option key={app.bundleId} value={app.bundleId}>{app.name} ({app.bundleId})</option>)}
      </optgroup>)}
    </select></label></div>
    <p className="sim-panel-note">Current permissions cannot be read. Rows show only the last action in this session.</p>
    <p className="sim-panel-note">Some changes quit the running app.</p>
    {error ? <p className="sims-error" role="alert">{error}</p> : null}
    {SIM_PRIVACY_SERVICES.map((service) => <div className="sim-permission-row" key={service} role="group" aria-label={service}>
      <strong>{service}</strong><span>{actions[`${bundleId}:${service}`] ? `Last action: ${labels[actions[`${bundleId}:${service}`]]}` : 'No action this session'}</span>
      <div className="sim-panel-buttons">{(['grant', 'revoke', 'reset'] as const).map((operation) => <button key={operation} type="button"
        disabled={!bundleId || busy.has(`${bundleId}:${service}`) || busy.has(`${bundleId}:all`) || (service === 'all' && appBusy)}
        onClick={() => void perform(service, operation)}>{operation === 'grant' ? 'Grant' : operation === 'revoke' ? 'Deny' : 'Reset'}</button>)}</div>
    </div>)}
    <button type="button" disabled={!bundleId || appBusy} onClick={() => void perform('all', 'reset')}>Reset all for this app</button>
  </aside>
}
