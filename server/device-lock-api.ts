import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  DeviceLockError, MAX_SKIPS, OFFER_TIMEOUT_MS, UNDELIVERED_OFFER_TIMEOUT_MS, type DeviceHolder, type DeviceLockRegistry, type DeviceResource, type LockResult, type QueueEntry, type SweepEvents,
} from './device-locks.js'

const PANE_ID = /^%\d+$/
const MAX_WAIT_SECONDS = 55
/** Commands that merely mention a build (searching logs, reading or editing files) without running one. */
const READERS = new Set(['grep', 'egrep', 'rg', 'ag', 'tail', 'head', 'less', 'more', 'cat', 'bat', 'vi', 'vim', 'nvim', 'nano', 'code', 'cursor', 'ps', 'pgrep', 'man', 'open'])

/** Watches the process table for builds that make the host busy outside the lock (`busyProcesses`). */
export class BusyProcessWatch {
  private lines: Array<{ pid: number; command: string }> = []
  constructor(private readonly list: () => Promise<string> = () => new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,command='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })) {}

  async refresh(): Promise<void> {
    this.lines = (await this.list()).split('\n').map((line) => /^\s*(\d+)\s+(.*)$/.exec(line)).filter((match) => match !== null)
      .map((match) => ({ pid: Number(match[1]), command: match[2] }))
      .filter((entry) => entry.pid !== process.pid && !entry.command.includes('commando-device') && !READERS.has(entry.command.split(/\s+/, 1)[0].split('/').pop()!))
  }

  busy = (resource: DeviceResource): string | undefined => {
    for (const fragment of resource.busyProcesses ?? []) {
      const match = this.lines.find((entry) => entry.command.includes(fragment))
      if (match) return `${fragment} (pid ${match.pid})`
    }
    return undefined
  }
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The texts Commando posts into an agent's pane when its place in the queue changes. */
export function offerMessage(entry: QueueEntry, resource: DeviceResource, cli: string): string {
  const as = entry.as ? ` --as ${JSON.stringify(entry.as)}` : ''
  return [
    `[Commando device lock] ${resource.name} is yours for "${entry.task}".`,
    `Claim it within 5 minutes with: ${cli} claim ${resource.id}${as} — otherwise it passes to the next task.`,
    ...(resource.release ? [`Before releasing: ${resource.release}.`] : []),
    `Release it when done with: ${cli} release ${resource.id}${as}`,
  ].join('\n')
}

export function expiredMessage(entry: QueueEntry & { dropped: boolean }, resource: DeviceResource, cli: string, position: number): string {
  const as = entry.as ? ` --as ${JSON.stringify(entry.as)}` : ''
  if (entry.dropped) {
    return `[Commando device lock] Your turn on ${resource.name} passed ${MAX_SKIPS} times without a claim, so your request left the queue. ` +
      `To queue again: ${cli} lock ${entry.request}${as} --task ${JSON.stringify(entry.task)}`
  }
  return `[Commando device lock] Your turn on ${resource.name} passed: the offer wasn't claimed in time, so the next task went first. ` +
    `You are still queued (#${position}); Commando will message you again when it is your turn.`
}

export function removedByUserMessage(entry: QueueEntry, resource: DeviceResource): string {
  return `[Commando device lock] The user removed your request for ${resource.name} ("${entry.task}") from the queue. Don't use the device.`
}

export function releasedByUserMessage(holder: DeviceHolder, resource: DeviceResource): string {
  return `[Commando device lock] The user released your lock on ${resource.name} ("${holder.task}"). Stop using the device.`
}

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new DeviceLockError(415, 'Content-Type must be application/json')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16 * 1024) throw new DeviceLockError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch { throw new DeviceLockError(400, 'Request body must be a JSON object') }
}

export type DeviceLockApiDependencies = {
  token: string
  registry: DeviceLockRegistry
  paneExists: (paneId: string) => boolean
  sessionName: (paneId: string) => Promise<string | null>
  processes: BusyProcessWatch
  /** Queues a message for an agent pane, delivered when its turn ends; returns an id to follow it. */
  message: (paneId: string, text: string) => Promise<string | undefined>
  /** Withdraws a message that has not been delivered yet. */
  cancelMessage?: (id: string) => Promise<void>
  /** How agents run the CLI, quoted into messages. */
  cli: string
  pidAlive?: (pid: number) => boolean
}

/** Agent-facing routes under /api/device-locks, authorised by the agent hook token. */
export class DeviceLockApi {
  private readonly tokenDigest: Buffer
  private sweeping?: Promise<void>
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly dependencies: DeviceLockApiDependencies) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = createHash('sha256').update(dependencies.token).digest()
    dependencies.registry.onOffered((entries) => this.offered(entries))
  }

  /** Tells each agent offered a lock; scripts that block are granted directly and need no message. */
  private offered(entries: QueueEntry[]): void {
    const { registry, cli, message } = this.dependencies
    for (const entry of entries) {
      const resource = entry.offer && registry.resource(entry.offer.resourceId)
      if (!resource || entry.mode !== 'notify') continue
      const offerAt = entry.offer!.at
      void message(entry.paneId, offerMessage(entry, resource, cli)).then((id) => {
        if (!id) registry.offerDelivered({ entryId: entry.id })
        // The offer may have gone while the message was being queued; then the message must not go out.
        else if (!registry.offerMessage(entry.id, offerAt, id)) void this.dependencies.cancelMessage?.(id).catch(() => {})
      }, (error) => {
        console.warn('[device-locks] could not message', entry.paneId, error)
        registry.offerDelivered({ entryId: entry.id })
      })
    }
  }

  /**
   * Follows offer messages: the claim window starts once the agent has the message. A message that
   * can't be delivered (the pane isn't an agent, or it failed) starts the window too.
   */
  messageSettled(id: string, status: 'delivered' | 'failed' | 'cancelled', at?: number): void {
    if (status !== 'cancelled') this.dependencies.registry.offerDelivered({ messageId: id }, at)
  }

  start(intervalMs = 5_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, intervalMs)
    this.timer.unref()
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined }

  /** Ends dead locks, expires offers, serves the queue and messages the panes concerned. */
  sweep(): Promise<void> {
    this.sweeping ??= (async () => {
      try {
        await this.refreshProcesses()
        const { registry, paneExists } = this.dependencies
        this.lapsed(registry.sweep({ paneExists, pidAlive: this.dependencies.pidAlive ?? pidAlive, busy: this.dependencies.processes.busy }))
      } catch (error) { console.warn('[device-locks] sweep failed', error) }
      finally { this.sweeping = undefined }
    })()
    return this.sweeping
  }

  /** Withdraws an offer message that hasn't reached the agent yet (the offer lapsed or was taken back). */
  withdrawOffer(entry: QueueEntry): void {
    if (entry.offer?.messageId) void this.dependencies.cancelMessage?.(entry.offer.messageId).catch(() => {})
  }


  /** Tells agents whose offer lapsed, withdrawing the offer message if it never arrived. */
  private lapsed(events: SweepEvents): void {
    const { registry, cli, message } = this.dependencies
    for (const entry of events.expired) {
      const resource = entry.offer && registry.resource(entry.offer.resourceId)
      if (!resource) continue
      this.withdrawOffer(entry)
      const queued = registry.entry(entry.id)
      void message(entry.paneId, expiredMessage(entry, resource, cli, queued ? registry.position(queued) : 0))
        .catch((error) => console.warn('[device-locks] could not message', entry.paneId, error))
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    if (path !== '/api/device-locks' && !path.startsWith('/api/device-locks/')) return false
    const routes: Record<string, string[]> = {
      '/api/device-locks': ['GET'], '/api/device-locks/lock': ['POST'], '/api/device-locks/claim': ['POST'], '/api/device-locks/release': ['POST'],
      '/api/device-locks/cancel': ['POST'], '/api/device-locks/entry': ['GET'], '/api/device-locks/mine': ['GET'], '/api/device-locks/resources': ['POST', 'DELETE'],
    }
    try {
      const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
      if (!token || token.length > 1_024 || !timingSafeEqual(createHash('sha256').update(token).digest(), this.tokenDigest)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
        throw new DeviceLockError(401, 'Unauthorized')
      }
      const allowed = routes[path]
      if (!allowed) throw new DeviceLockError(404, 'Not found')
      if (!allowed.includes(request.method ?? '')) { response.setHeader('Allow', allowed.join(', ')); throw new DeviceLockError(405, 'Method not allowed') }
      const { registry } = this.dependencies
      if (path === '/api/device-locks') { writeJson(response, 200, this.view()); return true }
      if (path === '/api/device-locks/entry') { writeJson(response, 200, await this.waitForEntry(url)); return true }
      if (path === '/api/device-locks/mine') {
        const { paneId } = await this.owner(request, {})
        const view = this.view()
        writeJson(response, 200, { holders: view.holders.filter((entry) => entry.paneId === paneId), queue: view.queue.filter((entry) => entry.paneId === paneId) })
        return true
      }
      const body = await readJson(request)
      if (path === '/api/device-locks/resources') {
        if (request.method === 'POST') writeJson(response, 200, { resource: registry.addResource(body, await this.busyCheck()) })
        else { registry.removeResource(String(body.id ?? '')); writeJson(response, 200, { ok: true }) }
        return true
      }
      const owner = await this.owner(request, body)
      const busy = await this.busyCheck()
      if (path === '/api/device-locks/lock') writeJson(response, 200, this.describe(registry.lock({ ...body, ...owner }, busy)))
      else if (path === '/api/device-locks/claim') writeJson(response, 200, this.describe(registry.claim(owner, optionalText(body.request))))
      else if (path === '/api/device-locks/release') writeJson(response, 200, { released: registry.release(owner, optionalText(body.request), busy) })
      else if (typeof body.entryId === 'string') writeJson(response, 200, { withdrawn: registry.withdraw(owner.paneId, body.entryId, busy) })
      else writeJson(response, 200, { cancelled: registry.cancel(owner, optionalText(body.request), busy) })
    } catch (error) {
      if (!(error instanceof DeviceLockError)) console.warn('[device-locks] request failed', error)
      writeJson(response, error instanceof DeviceLockError ? error.status : 500, { error: error instanceof DeviceLockError ? error.message : 'Device lock request failed' })
    }
    return true
  }

  /** Everything an agent or the CLI needs to show the current state. */
  view() {
    const snapshot = this.dependencies.registry.snapshot()
    // claimBy: when an offer lapses — 5 minutes after the agent got the message, or 15 if it never arrives.
    return { ...snapshot, queue: snapshot.queue.map((entry) => ({ ...entry, position: this.dependencies.registry.position(entry),
      ...(entry.offer ? { claimBy: entry.offer.deliveredAt !== undefined ? entry.offer.deliveredAt + OFFER_TIMEOUT_MS : entry.offer.at + UNDELIVERED_OFFER_TIMEOUT_MS } : {}) })),
      waitingFor: Object.fromEntries(snapshot.resources.map((resource) => [resource.id, this.dependencies.processes.busy(resource)]).filter(([, busy]) => busy)) }
  }

  private describe(result: LockResult) {
    if (result.status !== 'queued') return result
    const { registry } = this.dependencies
    const holders = result.entry.resourceIds.flatMap((id) => registry.holdersOf(id))
    const offered = registry.snapshot().queue.filter((entry) => entry.offer && result.entry.resourceIds.includes(entry.offer.resourceId))
    const waitingFor = result.entry.resourceIds.map((id) => registry.resource(id)).filter((resource) => resource !== undefined)
      .map((resource) => this.dependencies.processes.busy(resource)).find(Boolean)
    return { ...result, holders, offered, ...(waitingFor ? { waitingFor } : {}) }
  }

  private async owner(request: IncomingMessage, body: Record<string, unknown>) {
    const paneId = request.headers['x-commando-pane']
    if (typeof paneId !== 'string' || !PANE_ID.test(paneId)) throw new DeviceLockError(400, 'X-Commando-Pane must be a tmux pane id')
    if (!this.dependencies.paneExists(paneId)) throw new DeviceLockError(404, 'Tmux pane does not exist')
    const sessionName = await this.dependencies.sessionName(paneId) ?? paneId
    return { paneId, sessionName, ...(body.as !== undefined ? { as: body.as } : {}), ...(body.pid !== undefined ? { pid: body.pid } : {}) }
  }

  /** Refreshes the process list only when some resource cares about it. */
  private async refreshProcesses(): Promise<void> {
    if (this.dependencies.registry.snapshot().resources.some((resource) => resource.busyProcesses?.length)) {
      await this.dependencies.processes.refresh().catch((error) => console.warn('[device-locks] could not list processes', error))
    }
  }

  async busyCheck() {
    await this.refreshProcesses()
    return this.dependencies.processes.busy
  }

  /** Long-polls one queue entry until it changes (offered, granted or gone) or the wait ends. */
  private async waitForEntry(url: URL) {
    const id = url.searchParams.get('id') ?? ''
    const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0))
    const { registry } = this.dependencies
    const state = () => {
      const entry = registry.entry(id)
      if (entry?.offer) return { status: 'offered', entry, resource: registry.resource(entry.offer.resourceId) }
      if (entry) return this.describe({ status: 'queued', entry, position: registry.position(entry) })
      const holder = id ? registry.snapshot().holders.find((candidate) => candidate.entryId === id) : undefined
      return holder ? { status: 'held', holder, resource: registry.resource(holder.resourceId) } : { status: 'gone' }
    }
    const initial = state()
    if (!seconds || initial.status === 'held' || initial.status === 'gone') return initial
    const before = JSON.stringify(initial)
    return await new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); unsubscribe(); resolve(state()) }
      const timer = setTimeout(finish, seconds * 1_000)
      const unsubscribe = registry.onChange(() => { if (JSON.stringify(state()) !== before) finish() })
    })
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
