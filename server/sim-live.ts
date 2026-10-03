import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

const UDID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const TYPES = new Set(['touch1-down', 'touch1-move', 'touch1-up', 'touch2-down', 'touch2-move', 'touch2-up', 'key', 'type', 'paste', 'button', 'scroll'])
const MAX_CHUNK = 16 * 1024 * 1024
export type SimLiveSpawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams
export type SimLiveSocket = Pick<WebSocket, 'send' | 'close' | 'on' | 'readyState' | 'bufferedAmount'>
type Session = {
  viewers: Set<SimLiveSocket>; readyViewers: Set<SimLiveSocket>
  children: Set<ChildProcessWithoutNullStreams>; ready: Promise<void>
  stream?: ChildProcessWithoutNullStreams; input?: ChildProcessWithoutNullStreams
  width: number; height: number; description?: Buffer; stopped: boolean
}

export function simLiveUdid(path: string): string | null {
  // /ws alias passes through the existing development WebSocket proxy.
  const match = /^(?:\/ws)?\/api\/sims\/([^/]+)\/live$/.exec(path)
  return match && UDID.test(match[1]) ? match[1].toUpperCase() : null
}

/** Reject malformed envelopes before handing anything to the persistent input process. */
export function simGesture(value: unknown, width: number, height: number): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const gesture = value as Record<string, unknown>
  if (typeof gesture.type !== 'string' || !TYPES.has(gesture.type)) return null
  for (const [field, item] of Object.entries(gesture)) {
    if (typeof item === 'number' && !Number.isFinite(item)) return null
    if (['x', 'y', 'x1', 'y1', 'x2', 'y2', 'deltaX', 'deltaY', 'duration', 'width', 'height'].includes(field) && (typeof item !== 'number' || !Number.isFinite(item))) return null
  }
  const fields = gesture.type.startsWith('touch1-') ? ['x', 'y'] : gesture.type.startsWith('touch2-') ? ['x1', 'y1', 'x2', 'y2'] : []
  if (fields.some((field) => typeof gesture[field] !== 'number')) return null
  if (gesture.edge !== undefined && !['left', 'right', 'top', 'bottom'].includes(String(gesture.edge))) return null
  if (gesture.type === 'key' && (typeof gesture.code !== 'string' || gesture.code.length > 64 || (gesture.modifiers !== undefined && (!Array.isArray(gesture.modifiers) || gesture.modifiers.some((item) => !['shift', 'control', 'option', 'command'].includes(item)))))) return null
  if (gesture.type === 'type' && (typeof gesture.text !== 'string' || gesture.text.length > 4096)) return null
  // Unlike `type`, paste goes through the simulator pasteboard and carries any unicode text.
  if (gesture.type === 'paste' && (typeof gesture.text !== 'string' || !gesture.text || gesture.text.length > 4096 || (gesture.press !== undefined && typeof gesture.press !== 'boolean'))) return null
  if (gesture.type === 'button' && (typeof gesture.button !== 'string' || !['home', 'lock', 'power', 'volume-up', 'volume-down', 'action', 'app-switcher', 'swipe-to-app-switcher', 'swipe-to-home', 'pull-down-to-lock-screen', 'pull-down-to-notification-center'].includes(gesture.button))) return null
  return { ...gesture, width, height }
}

export class SimLiveService {
  private readonly sessions = new Map<string, Session>()
  private readonly spawner: SimLiveSpawn
  private readonly command: string
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has('commando-live') ? 'commando-live' : false })
  private closed = false

  constructor(options: { spawn?: SimLiveSpawn; command?: string } = {}) {
    this.spawner = options.spawn ?? ((command, args) => spawn(command, args, { stdio: 'pipe' }))
    this.command = options.command ?? (existsSync('/opt/homebrew/bin/baguette') ? '/opt/homebrew/bin/baguette' : 'baguette')
  }

  /** The caller uses the browser socket's network and session authorization before upgrading. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, udid: string): void {
    this.sockets.handleUpgrade(request, socket, head, (viewer) => this.connect(udid, viewer))
  }

  connect(udid: string, viewer: SimLiveSocket): void {
    if (this.closed || !UDID.test(udid)) { viewer.close(1008, 'Live simulator unavailable'); return }
    udid = udid.toUpperCase()
    let session = this.sessions.get(udid)
    if (!session) {
      if (this.sessions.size >= 2) { viewer.close(1013, 'Two simulators are already live; close a live view and try again'); return }
      session = { viewers: new Set(), readyViewers: new Set(), children: new Set(), width: 0, height: 0, stopped: false, ready: Promise.resolve() }
      this.sessions.set(udid, session)
      session.ready = this.start(udid, session)
    }
    const current = session
    current.viewers.add(viewer)
    const disconnect = () => {
      current.viewers.delete(viewer)
      current.readyViewers.delete(viewer)
      if (current.viewers.size === 0) this.stop(udid, current)
    }
    viewer.on('close', disconnect)
    viewer.on('error', disconnect)
    viewer.on('message', (data, binary) => {
      if (binary || !current.readyViewers.has(viewer) || !current.input) return
      let parsed: unknown
      try { parsed = JSON.parse(data.toString()) } catch { return }
      const gesture = simGesture(parsed, current.width, current.height)
      if (!gesture || (String(gesture.type).endsWith('-move') && current.input.stdin.writableNeedDrain)) return
      current.input.stdin.write(`${JSON.stringify(gesture)}\n`)
    })
    void current.ready.then(() => {
      if (current.stopped || !current.viewers.has(viewer) || viewer.readyState !== WebSocket.OPEN) return
      viewer.send(JSON.stringify({ type: 'meta', width: current.width, height: current.height }))
      current.readyViewers.add(viewer)
      if (current.description) viewer.send(current.description)
      current.stream?.stdin.write('{"cmd":"force_idr"}\n{"cmd":"snapshot"}\n')
    }).catch((error: NodeJS.ErrnoException) => {
      this.stop(udid, current, error.code === 'ENOENT' ? 'Baguette is not installed; using snapshots' : 'Live simulator could not start; using snapshots')
    })
  }

  private child(udid: string, session: Session, args: string[]): ChildProcessWithoutNullStreams {
    const child = this.spawner(this.command, args)
    session.children.add(child)
    // Drain all pipes, including input acknowledgements, so children cannot block.
    child.stderr.resume()
    child.stdin.on('error', () => this.stop(udid, session, 'Simulator input closed; using snapshots'))
    return child
  }

  private async start(udid: string, session: Session): Promise<void> {
    const layout = this.child(udid, session, ['chrome', 'layout', '--udid', udid])
    const screen = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => { reject(new Error('Layout timed out')); layout.kill() }, 10_000)
      layout.on('error', (error) => { clearTimeout(timer); reject(error) })
      layout.stdout.on('data', (chunk: Buffer) => {
        data += chunk.toString()
        if (data.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('Layout too large')); layout.kill() }
      })
      layout.on('close', (code) => {
        clearTimeout(timer)
        session.children.delete(layout)
        try {
          if (code !== 0) throw new Error('Layout failed')
          const value = JSON.parse(data).screen as { width: number; height: number }
          if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) throw new Error('Invalid screen size')
          resolve(value)
        } catch (error) { reject(error) }
      })
    })
    if (session.stopped) return
    session.width = screen.width; session.height = screen.height
    const stream = session.stream = this.child(udid, session, ['stream', '--udid', udid, '--format', 'avcc', '--fps', '30', '--scale', '2'])
    const input = session.input = this.child(udid, session, ['input', '--udid', udid])
    for (const child of [stream, input]) {
      child.on('error', (error: NodeJS.ErrnoException) => this.stop(udid, session, error.code === 'ENOENT' ? 'Baguette is not installed; using snapshots' : 'Live simulator failed; using snapshots'))
      child.on('close', () => this.stop(udid, session, 'Live simulator stopped; using snapshots'))
    }
    input.stdout.resume()
    let buffered = Buffer.alloc(0)
    stream.stdout.on('data', (chunk: Buffer) => {
      if (session.stopped) return
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (length < 1 || length > MAX_CHUNK) { this.stop(udid, session, 'Invalid simulator stream'); return }
        if (buffered.length < 4 + length) break
        const frame = Buffer.from(buffered.subarray(4, 4 + length))
        buffered = buffered.subarray(4 + length)
        if (frame[0] < 1 || frame[0] > 4) { this.stop(udid, session, 'Invalid simulator frame'); return }
        if (frame[0] === 1) session.description = frame
        for (const viewer of session.readyViewers) {
          // Never drop H.264 deltas and keep a decoder on a broken dependency chain.
          if (viewer.bufferedAmount > MAX_CHUNK) { viewer.close(1013, 'Live viewer is too slow; using snapshots'); continue }
          if (viewer.readyState === WebSocket.OPEN) viewer.send(frame)
        }
      }
    })
  }

  private stop(udid: string, session: Session, reason?: string): void {
    if (session.stopped) return
    session.stopped = true
    if (this.sessions.get(udid) === session) this.sessions.delete(udid)
    for (const child of session.children) child.kill()
    session.children.clear()
    for (const viewer of session.viewers) viewer.close(1011, reason ?? 'Live simulator closed')
    session.viewers.clear(); session.readyViewers.clear()
  }

  close(): void {
    this.closed = true
    for (const [udid, session] of this.sessions) this.stop(udid, session)
    this.sockets.close()
  }
}
