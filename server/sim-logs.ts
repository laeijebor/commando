import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { WebSocket, WebSocketServer } from 'ws'
import { SIM_BUNDLE_ID, type SimLogLevel, type SimLogLine } from '../shared/sim-actions.js'
import type { SimLiveSocket, SimLiveSpawn } from './sim-live.js'

const UDID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const MAX_LINE = 64 * 1024
type Filters = { level: SimLogLevel; bundle?: string }

export function simLogsUdid(path: string): string | null {
  const match = /^(?:\/ws)?\/api\/sims\/([^/]+)\/logs$/.exec(path)
  return match && UDID.test(match[1]) ? match[1].toUpperCase() : null
}

export function simLogFilters(params: URLSearchParams): Filters | null {
  const level = params.get('level') ?? 'info', bundle = params.get('bundle')
  if (params.getAll('level').length > 1 || params.getAll('bundle').length > 1 || !['default', 'info', 'debug'].includes(level)
    || (bundle !== null && !SIM_BUNDLE_ID.test(bundle))) return null
  return { level: level as SimLogLevel, ...(bundle !== null ? { bundle } : {}) }
}

export function parseSimLogLine(line: string): SimLogLine {
  let value: unknown
  try { value = JSON.parse(line) } catch { /* Diagnostics remain visible as plain text. */ }
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const field = (key: string, limit: number) => typeof item[key] === 'string' ? item[key].slice(0, limit) : ''
  return { t: field('timestamp', 128), level: field('messageType', 64) || 'default', process: field('processImagePath', 1024),
    ...(field('subsystem', 1024) ? { subsystem: field('subsystem', 1024) } : {}),
    ...(field('category', 1024) ? { category: field('category', 1024) } : {}),
    message: typeof item.eventMessage === 'string' ? item.eventMessage.slice(0, 4000) : line.slice(0, 4000) }
}

export class SimLogsService {
  private readonly streams = new Map<SimLiveSocket, () => void>()
  private readonly spawner: SimLiveSpawn
  private readonly command: string
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false,
    handleProtocols: (protocols) => protocols.has('commando-live') ? 'commando-live' : false })
  private closed = false

  constructor(options: { spawn?: SimLiveSpawn; command?: string } = {}) {
    this.spawner = options.spawn ?? ((command, args) => spawn(command, args, { stdio: 'pipe' }))
    this.command = options.command ?? (existsSync('/opt/homebrew/bin/baguette') ? '/opt/homebrew/bin/baguette' : 'baguette')
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, udid: string, params: URLSearchParams): void {
    this.sockets.handleUpgrade(request, socket, head, (viewer) => this.connect(udid, viewer, params))
  }

  connect(udid: string, viewer: SimLiveSocket, params = new URLSearchParams()): void {
    const filters = simLogFilters(params)
    if (this.closed || !UDID.test(udid) || !filters) { viewer.close(1008, 'Invalid simulator log filters or device'); return }
    if (this.streams.size >= 4) { viewer.close(1013, 'Four log streams are already open; close a Logs panel and try again'); return }
    let child: ReturnType<SimLiveSpawn> | undefined, stopped = false
    const stop = (reason?: string) => {
      if (stopped) return
      stopped = true; this.streams.delete(viewer)
      child?.kill()
      if (reason) viewer.close(1011, reason)
    }
    this.streams.set(viewer, () => stop('Simulator logs closed'))
    viewer.on('close', () => stop()); viewer.on('error', () => stop())
    try {
      child = this.spawner(this.command, ['logs', '--udid', udid.toUpperCase(), '--style', 'ndjson', '--level', filters.level,
        ...(filters.bundle ? ['--bundle-id', filters.bundle] : [])])
    } catch (error) { stop((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Baguette is not installed' : 'Simulator logs could not start'); return }
    child.stderr.resume()
    child.stdin.on('error', () => stop('Simulator logs input closed'))
    child.on('error', (error: NodeJS.ErrnoException) => stop(error.code === 'ENOENT' ? 'Baguette is not installed' : 'Simulator logs failed'))
    const decoder = new StringDecoder('utf8')
    let pending = '', skipping = false
    const forward = (line: string) => {
      if (!line.trim() || stopped || viewer.readyState !== WebSocket.OPEN || viewer.bufferedAmount > 256 * 1024) return
      viewer.send(JSON.stringify(parseSimLogLine(line)))
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk)
      let start = 0, end: number
      while ((end = text.indexOf('\n', start)) !== -1) {
        if (!skipping) forward((pending + text.slice(start, Math.min(end, start + MAX_LINE - pending.length))).replace(/\r$/, ''))
        pending = ''; skipping = false; start = end + 1
      }
      if (skipping) return
      pending += text.slice(start, start + MAX_LINE - pending.length)
      // A missing newline must never grow the parser buffer without bound.
      if (pending.length >= MAX_LINE) { forward(pending); pending = ''; skipping = true }
    })
    child.on('close', () => { if (!skipping) forward(pending + decoder.end()); stop('Simulator log stream exited') })
  }

  close(): void {
    this.closed = true
    for (const stop of this.streams.values()) stop()
    this.sockets.close()
  }
}
