import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import QRCode from 'qrcode'
import type { PairedDevice, PairingCodeResponse } from '../shared/pairing'
import { createPairingCode, listPairedDevices, pairingLink, revokePairedDevice } from './pairingApi'

export function PairPhoneDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [details, setDetails] = useState<PairingCodeResponse | null>(null)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const remaining = details ? Math.max(0, Math.ceil((details.expiresAt - now) / 1000)) : 0

  useEffect(() => {
    dialog.current?.showModal()
    const controller = new AbortController()
    setBusy(true)
    void createPairingCode(token, controller.signal).then(setDetails).catch(() => {
      if (!controller.signal.aborted) setError('Could not create a code. Sign in as the owner and try again.')
    }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    const refresh = () => {
      void listPairedDevices(token, controller.signal).then(({ devices }) => setDevices(devices)).catch(() => {
        if (!controller.signal.aborted) setError('Could not load paired devices.')
      })
    }
    refresh()
    const poll = setInterval(refresh, 3000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { controller.abort(); clearInterval(poll); clearInterval(clock) }
  }, [token])

  useEffect(() => {
    if (!details || !canvas.current) return
    void QRCode.toCanvas(canvas.current, pairingLink(details), {
      width: 280, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#100d1a', light: '#ffffff' },
    }).catch(() => setError('Could not render the code. Try a new code.'))
  }, [details])

  const newCode = async () => {
    setBusy(true)
    setError('')
    setDetails(null)
    try { setDetails(await createPairingCode(token)); setNow(Date.now()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a code.') }
    finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    setRevoking(id)
    setError('')
    try { await revokePairedDevice(token, id); setDevices((current) => current.filter((device) => device.id !== id)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not revoke device.') }
    finally { setRevoking(null) }
  }

  return (
    <dialog ref={dialog} className="pair-phone-dialog" aria-labelledby="pair-phone-title" data-native-terminal-occluder="" onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="pair-phone-content">
        <header><div><span className="section-kicker">Machine</span><h2 id="pair-phone-title">Pair a phone</h2></div><button type="button" className="icon-button" aria-label="Close pairing" onClick={onClose}><X /></button></header>
        <p>Scan with your iPhone Camera or Commando’s Hosts → Scan QR code. Confirm the machine on your phone.</p>
        <div className="pair-phone-qr">
          {details && remaining > 0 ? <canvas ref={canvas} role="img" aria-label="One-time phone pairing QR code" /> : <p>{busy ? 'Creating code…' : 'Code expired. Generate a new code.'}</p>}
        </div>
        <div className="pair-phone-actions"><span role="timer">{details && remaining > 0 ? `Expires in ${remaining}s · single use` : 'One-time pairing code'}</span><button type="button" onClick={() => void newCode()} disabled={busy}>New code</button></div>
        {details && !details.tailscaleEnabled ? <p className="pair-phone-hint">This QR uses loopback for a simulator. Phones need COMMANDO_TAILSCALE=true on the Mac and Tailscale on both devices.</p> : null}
        {error ? <p role="alert" className="pair-phone-error">{error}</p> : null}
        <h3>Paired devices</h3>
        {devices.length === 0 ? <p>No paired devices yet.</p> : <ul className="pair-phone-devices">{devices.map((device) => <li key={device.id}><div><strong>{device.deviceName}</strong><span>{device.platform} · Paired {new Date(device.createdAt).toLocaleString()}</span><span>Last seen {new Date(device.lastSeenAt).toLocaleString()}</span></div><button type="button" disabled={revoking !== null} onClick={() => void revoke(device.id)} aria-label={`Revoke ${device.deviceName}`}>{revoking === device.id ? 'Revoking…' : 'Revoke'}</button></li>)}</ul>}
      </div>
    </dialog>
  )
}
