import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowRightLeft, PlugZap, RefreshCw, Trash2, Wrench } from 'lucide-react'
import { createOwnerJsonRequest } from './webPanesApi'

export type DeviceFarmStatus = {
  use: 'builtin' | 'farm'
  switching?: 'farm' | 'builtin'
  waitingOn?: { held: number; queued: number }
  local: { url: string; checkout: string | null; configured: boolean; hasToken: boolean; connected?: boolean; error?: string; engineer?: string
    service?: { installed?: boolean; state?: string; healthy?: boolean; error?: string } }
  remote: { url: string; connected?: boolean; error?: string; engineer?: string } | null
  builtin: { devices: number; held: number; queued: number }
  error?: string
}

export type DeviceFarmApi = ReturnType<typeof createDeviceFarmApi>

export function createDeviceFarmApi(token: string, fetcher: typeof fetch = fetch) {
  const request = createOwnerJsonRequest(token, fetcher)
  return {
    status: async () => await request('/api/device-farm', { method: 'GET' }) as DeviceFarmStatus,
    setupLocal: async (checkout?: string) => await request('/api/device-farm/local/setup', { method: 'POST', body: JSON.stringify(checkout ? { checkout } : {}) }) as DeviceFarmStatus,
    setRemote: async (url: string, token: string) => await request('/api/device-farm/remote', { method: 'POST', body: JSON.stringify({ url, token }) }) as DeviceFarmStatus,
    removeRemote: async () => await request('/api/device-farm/remote', { method: 'DELETE' }) as DeviceFarmStatus,
    switchTo: async (to: 'farm' | 'builtin' | null) => await request('/api/device-farm/switch', { method: 'POST', body: JSON.stringify({ to }) }) as DeviceFarmStatus,
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function localState(status: DeviceFarmStatus): { tone: 'ok' | 'warn' | 'off'; text: string } {
  const { local } = status
  if (!local.configured || !local.hasToken) return { tone: 'off', text: 'Not set up yet' }
  if (local.service?.healthy || local.connected) return { tone: 'ok', text: `Running on ${local.url.replace(/^https?:\/\//, '')}${local.service?.state ? ` · launchd ${local.service.state}` : ''}` }
  return { tone: 'warn', text: `Not answering on ${local.url.replace(/^https?:\/\//, '')}${local.service?.state ? ` (launchd ${local.service.state})` : ''}` }
}

/** Settings > Device farm: where Commando's device locks run. */
export function DeviceFarmSection({ api }: { api: DeviceFarmApi }) {
  const [status, setStatus] = useState<DeviceFarmStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [checkout, setCheckout] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')

  const load = useCallback(async () => {
    try { setStatus(await api.status()); setError(undefined) } catch (cause) { setError((cause as Error).message) }
  }, [api])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, 5_000)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => { if (status?.local.checkout && !checkout) setCheckout(status.local.checkout) }, [status?.local.checkout, checkout])

  const act = async (label: string, action: () => Promise<DeviceFarmStatus>) => {
    setBusy(label)
    try { setStatus(await action()); setError(undefined) } catch (cause) { setError((cause as Error).message) } finally { setBusy(undefined) }
  }
  const connectRemote = (event: FormEvent) => {
    event.preventDefault()
    void act('remote', async () => { const next = await api.setRemote(remoteUrl, remoteToken); setRemoteToken(''); return next })
  }

  const local = status ? localState(status) : undefined
  const ready = Boolean(status?.local.configured && status.local.hasToken)

  return <section className="settings-section" aria-labelledby="settings-device-farm">
    <h3 id="settings-device-farm">Device farm</h3>
    <p className="settings-hint">Device locks (phones, the emulator, Mac builds) can run on a device farm instead of Commando&apos;s built-in queue:
      this Mac&apos;s own farm, plus optionally a shared remote farm whose devices appear alongside. Agents keep using <code>commando-device.mjs</code> as before.</p>
    {error ?? status?.error ? <p className="settings-error" role="alert">{error ?? status?.error}</p> : null}
    {!status ? <p className="settings-hint" role="status">Loading…</p> : <ul className="settings-profiles">
      <li className="settings-profile" data-state={status.use === 'farm' ? 'logged-in' : 'unknown'}>
        <div className="settings-profile-main">
          <strong>Queue in use</strong>
          <span>{status.use === 'farm' ? 'Device farm' : 'Commando’s built-in queue'}</span>
          <span className="settings-profile-status" role="status">
            {status.switching
              ? `Switching to ${status.switching === 'farm' ? 'the device farm' : 'the built-in queue'} once ${count(status.waitingOn?.held ?? 0, 'held device')} and ${count(status.waitingOn?.queued ?? 0, 'queued request')} have finished. Nothing is interrupted.`
              : status.use === 'builtin' ? `${count(status.builtin.devices, 'device')} · ${count(status.builtin.held, 'held')} · ${status.builtin.queued} queued` : 'Locks, queues and the Devices view now come from the farm.'}
          </span>
        </div>
        <div className="settings-profile-controls">
          {status.switching
            ? <button type="button" className="settings-button" disabled={Boolean(busy)} onClick={() => void act('switch', () => api.switchTo(null))}>Cancel switch</button>
            : <button type="button" className="settings-button" disabled={Boolean(busy) || (status.use === 'builtin' && !ready)}
                title={status.use === 'builtin' && !ready ? 'Set up this Mac’s farm first' : undefined}
                onClick={() => void act('switch', () => api.switchTo(status.use === 'farm' ? 'builtin' : 'farm'))}>
                <ArrowRightLeft aria-hidden="true" />{status.use === 'farm' ? 'Switch back to the built-in queue' : 'Switch to the device farm'}
              </button>}
        </div>
      </li>

      <li className="settings-profile" data-state={local?.tone === 'ok' ? 'logged-in' : local?.tone === 'warn' ? 'logged-out' : 'unknown'}>
        <div className="settings-profile-main">
          <strong>This Mac&apos;s farm</strong>
          <span className="settings-profile-status" role="status">{local?.text}{status.local.error ? ` · ${status.local.error}` : ''}</span>
          <label className="settings-farm-field">Checkout <input value={checkout} placeholder="~/dev/device-farm" disabled={Boolean(busy)}
            aria-label="device-farm checkout folder" onChange={(event) => setCheckout(event.target.value)} /></label>
          <span className="settings-hint settings-farm-note">Setup runs the farm as a launchd service on 127.0.0.1, copies Commando&apos;s devices into it (release steps and build rules included)
            and gives Commando its own token. Running it again is safe.</span>
        </div>
        <div className="settings-profile-controls">
          <button type="button" className="settings-button" disabled={Boolean(busy)} onClick={() => void act('setup', () => api.setupLocal(checkout.trim() || undefined))}>
            <Wrench aria-hidden="true" />{busy === 'setup' ? 'Setting up…' : ready ? 'Set up again' : 'Set up'}
          </button>
        </div>
      </li>

      <li className="settings-profile" data-state={status.remote ? (status.remote.connected ? 'logged-in' : 'logged-out') : 'unknown'}>
        <div className="settings-profile-main">
          <strong>Remote farm</strong>
          {status.remote ? <>
            <code>{status.remote.url}</code>
            <span className="settings-profile-status" role="status">
              {status.remote.connected ? `Connected${status.remote.engineer ? ` as ${status.remote.engineer}` : ''}` : status.use === 'farm' ? `Not connected${status.remote.error ? `: ${status.remote.error}` : ''}` : 'Saved; used once Commando is on the device farm'}
            </span>
          </> : <form className="settings-add settings-farm-remote" onSubmit={connectRemote} aria-label="Connect a remote device farm">
            <label>URL <input value={remoteUrl} placeholder="http://farm-mini:4500" disabled={Boolean(busy)} onChange={(event) => setRemoteUrl(event.target.value)} /></label>
            <label>Token <input type="password" value={remoteToken} placeholder="farm_…" autoComplete="off" disabled={Boolean(busy)} onChange={(event) => setRemoteToken(event.target.value)} /></label>
            <button type="submit" className="settings-button" disabled={Boolean(busy) || !remoteUrl.trim() || !remoteToken.trim()}>
              <PlugZap aria-hidden="true" />{busy === 'remote' ? 'Checking…' : 'Connect'}
            </button>
          </form>}
        </div>
        {status.remote ? <div className="settings-profile-controls">
          <button type="button" className="settings-button" disabled={Boolean(busy)} onClick={() => void act('remote', api.removeRemote)}><Trash2 aria-hidden="true" />Remove</button>
        </div> : null}
      </li>
    </ul>}
    <button type="button" className="settings-button" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw aria-hidden="true" />Refresh</button>
  </section>
}
