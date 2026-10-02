import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PaneRepo } from '../shared/protocol.js'

export type SimPaneContext = { sessionId: string; sessionName: string; repo?: PaneRepo }
export type SimLease = SimPaneContext & {
  udid: string
  paneId: string
  task: string
  label: string
  originalName: string
  ports: Array<{ name: string; port: number }>
  branchOverride?: string
  via: 'simslim' | 'simfleet' | 'adopted'
  adopted?: boolean
  createdAt: number
  lastActiveAt: number
}
export type EndedSimLease = Pick<SimLease, 'udid' | 'sessionName' | 'task' | 'label' | 'originalName' | 'repo' | 'paneId' | 'via' | 'adopted' | 'ports'> & {
  endedAt: number
  reason: 'pane-closed' | 'released'
}
const ENDED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
export const SIM_LEASE_IDLE_MS = 30 * 60 * 1_000
const UDID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PANE_ID = /^%\d+$/

class SimLeaseError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function defaultSimLeaseStatePath(port: number): string {
  return process.env.COMMANDO_SIM_LEASES_PATH ?? join(homedir(), '.commando', `sim-leases-${port}.json`)
}

export function cleanSimText(text: string): string {
  return text.replace(/\s+/gu, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').replace(/\s+/gu, ' ').trim()
}

export function formatSimLabel(sessionName: string, task = ''): string {
  const session = cleanSimText(sessionName)
  const description = cleanSimText(task)
  return Array.from(description ? `${session} · ${description}` : session).slice(0, 60).join('')
}

function parseInput(value: Record<string, unknown>): Pick<SimLease, 'udid' | 'task' | 'originalName' | 'via' | 'adopted' | 'ports' | 'branchOverride'> {
  const { udid, originalName, via, task = '' } = value
  if (typeof udid !== 'string' || !UDID.test(udid)) throw new SimLeaseError(400, 'udid must be a simulator UUID')
  if (typeof originalName !== 'string' || !originalName || originalName.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(originalName)) {
    throw new SimLeaseError(400, 'originalName is invalid')
  }
  if (via !== 'simslim' && via !== 'simfleet' && via !== 'adopted') throw new SimLeaseError(400, 'via is invalid')
  if (value.adopted !== undefined && (typeof value.adopted !== 'boolean' || value.adopted !== (via === 'adopted'))) throw new SimLeaseError(400, 'adopted must match via')
  return { udid: udid.toUpperCase(), originalName, via, adopted: via === 'adopted', task: parseTask(task),
    ports: parsePorts(value.ports === undefined ? [] : value.ports), ...parseBranch(value.branchOverride) }
}

function parseTask(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_096) throw new SimLeaseError(400, 'task must be text of at most 4096 characters')
  return cleanSimText(value)
}

function parsePorts(value: unknown): SimLease['ports'] {
  if (!Array.isArray(value) || value.length > 6) throw new SimLeaseError(400, 'ports must contain at most 6 named ports')
  const names = new Set<string>()
  return value.map((entry) => {
    if (!entry || typeof entry.name !== 'string' || !/^[a-z0-9-]{1,24}$/.test(entry.name) ||
      !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || names.has(entry.name)) {
      throw new SimLeaseError(400, 'ports require unique lowercase names and integer ports from 1 to 65535')
    }
    names.add(entry.name)
    return { name: entry.name, port: entry.port }
  })
}

function parseBranch(value: unknown): Pick<SimLease, 'branchOverride'> {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new SimLeaseError(400, 'branchOverride must be text of at most 200 characters without controls')
  }
  return { branchOverride: value }
}

function persistedRepo(value: unknown): PaneRepo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const repo = value as Partial<PaneRepo>
  if (typeof repo.root !== 'string' || !repo.root.startsWith('/') || typeof repo.name !== 'string' ||
    typeof repo.branch !== 'string' || typeof repo.isWorktree !== 'boolean' ||
    (repo.worktreeRoot !== undefined && typeof repo.worktreeRoot !== 'string') ||
    (repo.defaultBranch !== undefined && typeof repo.defaultBranch !== 'string')) return undefined
  return { root: repo.root, name: repo.name, branch: repo.branch, isWorktree: repo.isWorktree,
    ...(repo.worktreeRoot ? { worktreeRoot: repo.worktreeRoot } : {}),
    ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}) }
}

/** Metadata only: this registry never invokes simulator tools. */
export class SimLeaseRegistry {
  private leases: SimLease[] = []
  private ended: EndedSimLease[] = []
  private readonly reservations = new Map<string, { udid: string; operation: string; at: number }>()
  private readonly now: () => number
  private readonly statePath: string | undefined

  constructor(options: { statePath?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now
    this.statePath = options.statePath
    if (!this.statePath) return
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (parsed?.version !== 1 || !Array.isArray(parsed.leases)) return
      for (const value of parsed.leases) {
        try {
          const input = parseInput(value)
          if (!PANE_ID.test(value.paneId) || typeof value.sessionId !== 'string' || typeof value.sessionName !== 'string' ||
            !Number.isFinite(value.createdAt) || !Number.isFinite(value.lastActiveAt) ||
            this.leases.some((entry) => entry.paneId === value.paneId || entry.udid === input.udid)) continue
          const repo = persistedRepo(value.repo)
          this.leases.push({ ...input, paneId: value.paneId, sessionId: value.sessionId, sessionName: value.sessionName,
            label: formatSimLabel(value.sessionName, input.task), ...(repo ? { repo } : {}), createdAt: Math.min(value.createdAt, this.now()),
            lastActiveAt: Math.min(value.lastActiveAt, this.now()) })
        } catch { /* Ignore malformed entries. */ }
      }
      for (const value of Array.isArray(parsed.ended) ? parsed.ended : []) {
        try {
          const input = parseInput(value)
          if (!PANE_ID.test(value.paneId) || typeof value.sessionName !== 'string' ||
            !Number.isFinite(value.endedAt) || !['pane-closed', 'released'].includes(value.reason) ||
            this.leases.some((entry) => entry.udid === input.udid) || this.ended.some((entry) => entry.udid === input.udid)) continue
          const repo = persistedRepo(value.repo)
          this.ended.push({ udid: input.udid, sessionName: value.sessionName, task: input.task,
            label: formatSimLabel(value.sessionName, input.task), originalName: input.originalName,
            ...(repo ? { repo } : {}), paneId: value.paneId, via: input.via, adopted: input.adopted,
            ports: input.ports, endedAt: Math.min(value.endedAt, this.now()), reason: value.reason })
        } catch { /* Ignore malformed entries. */ }
      }
      this.ended = this.boundedEnded(this.ended)
    } catch { /* Missing or corrupt state starts empty. */ }
  }

  list(paneExists: (paneId: string) => boolean): Array<SimLease & { idle: boolean }> {
    const live = this.leases.filter((entry) => paneExists(entry.paneId))
    if (live.length !== this.leases.length) this.commit(live, [...this.ended,
      ...this.leases.filter((entry) => !live.includes(entry)).map((entry) => this.end(entry, 'pane-closed'))])
    for (const [paneId, reservation] of this.reservations) {
      if (!paneExists(paneId) || this.now() - reservation.at >= SIM_LEASE_IDLE_MS) this.reservations.delete(paneId)
    }
    return this.leases.map((entry) => ({ ...entry, idle: this.now() - entry.lastActiveAt >= SIM_LEASE_IDLE_MS }))
  }

  listEnded(): EndedSimLease[] {
    return this.boundedEnded(this.ended).map((entry) => ({ ...entry }))
  }

  pruneEnded(bootedUdids: string[]): void {
    const booted = new Set(bootedUdids.map((udid) => udid.toUpperCase()))
    const ended = this.boundedEnded(this.ended.filter((entry) => booted.has(entry.udid)))
    if (ended.length !== this.ended.length) this.commit(this.leases, ended)
  }

  private boundedEnded(ended: EndedSimLease[]): EndedSimLease[] {
    return ended.filter((entry) => this.now() - entry.endedAt < ENDED_MAX_AGE_MS)
      .sort((a, b) => b.endedAt - a.endedAt).slice(0, 50)
  }

  private end(entry: SimLease, reason: EndedSimLease['reason']): EndedSimLease {
    const { udid, sessionName, task, label, originalName, repo, paneId, via, adopted, ports } = entry
    return { udid, sessionName, task, label, originalName, repo, paneId, via, adopted, ports, endedAt: this.now(), reason }
  }

  context(paneId: string, target: SimPaneContext, paneExists: (paneId: string) => boolean) {
    const leases = this.list(paneExists)
    return { ...target, ended: this.listEnded(), lease: leases.find((entry) => entry.paneId === paneId) ?? null,
      heldUdids: [...new Set([...leases.filter((entry) => entry.paneId !== paneId).map((entry) => entry.udid),
        ...[...this.reservations].filter(([pane]) => pane !== paneId).map(([, entry]) => entry.udid)])] }
  }

  reserve(paneId: string, udid: unknown, requireUnleased = false): string {
    if (typeof udid !== 'string' || !UDID.test(udid)) throw new SimLeaseError(400, 'udid must be a simulator UUID')
    const canonicalUdid = udid.toUpperCase()
    if (this.reservations.has(paneId)) throw new SimLeaseError(409, 'This pane already has a simulator operation in progress')
    const existing = this.leases.find((entry) => entry.paneId === paneId)
    if (existing && requireUnleased) throw new SimLeaseError(409, 'Release this pane’s existing lease before adopting a simulator')
    if (existing && existing.udid !== canonicalUdid) throw new SimLeaseError(409, 'Release this pane’s existing lease first')
    this.assertFree(paneId, canonicalUdid)
    const operation = randomUUID()
    this.reservations.set(paneId, { udid: canonicalUdid, operation, at: this.now() })
    return operation
  }

  unlock(paneId: string, operation: unknown): void {
    this.assertOperation(paneId, operation)
    this.reservations.delete(paneId)
  }

  upsert(paneId: string, target: SimPaneContext, body: Record<string, unknown>): SimLease {
    if (!PANE_ID.test(paneId)) throw new SimLeaseError(400, 'paneId must be a tmux pane id')
    const input = parseInput(body)
    this.assertOperation(paneId, body.operation)
    this.assertFree(paneId, input.udid)
    const reserved = this.reservations.get(paneId)
    if (reserved && reserved.udid !== input.udid) throw new SimLeaseError(409, 'Device differs from the reservation')
    const existing = this.leases.find((entry) => entry.paneId === paneId)
    if (existing && existing.udid !== input.udid) throw new SimLeaseError(409, 'Release this pane’s existing lease first')
    const entry: SimLease = { ...input, ...target, ...(existing?.repo ? { repo: existing.repo } : {}), paneId, label: formatSimLabel(target.sessionName, input.task),
      originalName: existing?.originalName ?? this.listEnded().find((entry) => entry.udid === input.udid)?.originalName ?? input.originalName, via: existing?.via ?? input.via,
      adopted: existing?.adopted ?? input.adopted,
      createdAt: existing?.createdAt ?? this.now(), lastActiveAt: this.now() }
    this.commit([...this.leases.filter((lease) => lease.paneId !== paneId), entry], this.ended.filter((ended) => ended.udid !== input.udid))
    return { ...entry }
  }

  touch(paneId: string, target: SimPaneContext, body: Record<string, unknown>): SimLease {
    const existing = this.leases.find((entry) => entry.paneId === paneId)
    if (!existing) throw new SimLeaseError(404, 'This pane has no simulator lease')
    return this.upsert(paneId, target, { ...existing, ...body, udid: existing.udid, originalName: existing.originalName,
      via: existing.via, task: body.task === undefined ? existing.task : parseTask(body.task) })
  }

  delete(paneId: string, operation?: unknown): void {
    this.assertOperation(paneId, operation)
    const existing = this.leases.find((entry) => entry.paneId === paneId)
    this.commit(this.leases.filter((entry) => entry.paneId !== paneId), existing
      ? [...this.ended.filter((entry) => entry.udid !== existing.udid), this.end(existing, 'released')] : this.ended)
  }

  private assertOperation(paneId: string, operation: unknown): void {
    const reservation = this.reservations.get(paneId)
    if (reservation && operation !== reservation.operation) throw new SimLeaseError(409, 'Simulator operation is in progress')
    if (!reservation && operation !== undefined) throw new SimLeaseError(409, 'Simulator reservation expired; retry the command')
  }

  private assertFree(paneId: string, udid: string): void {
    if (this.leases.some((entry) => entry.udid === udid && entry.paneId !== paneId) ||
      [...this.reservations].some(([pane, entry]) => pane !== paneId && entry.udid === udid)) {
      throw new SimLeaseError(409, 'Simulator is held by another pane')
    }
  }

  private commit(leases: SimLease[], ended = this.ended): void {
    ended = this.boundedEnded(ended)
    if (this.statePath) {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 })
      const temporary = `${this.statePath}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, leases, ended }, null, 2), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    }
    this.leases = leases
    this.ended = ended
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'X-Content-Type-Options': 'nosniff' })
  response.end(body)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new SimLeaseError(415, 'Content-Type must be application/json')
  }
  if (Number(request.headers['content-length']) > 16 * 1024) throw new SimLeaseError(413, 'Request body is too large')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16 * 1024) throw new SimLeaseError(413, 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object')
    return body as Record<string, unknown>
  } catch { throw new SimLeaseError(400, 'Request body must be a JSON object') }
}

export class SimLeaseApi {
  private readonly tokenDigest: Buffer
  constructor(private readonly dependencies: {
    token: string
    registry: SimLeaseRegistry
    paneExists: (paneId: string) => boolean
    paneContext: (paneId: string) => Promise<SimPaneContext | null>
    onChange?: (paneId: string) => void | Promise<void>
  }) {
    if (dependencies.token.length < 32) throw new Error('Agent hook token must contain at least 32 characters')
    this.tokenDigest = createHash('sha256').update(dependencies.token).digest()
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname
    if (!['/api/sim-leases', '/api/sim-leases/context', '/api/sim-leases/reservation'].includes(path)) return false
    const allowed = path.endsWith('/context') ? ['GET'] : path.endsWith('/reservation') ? ['POST', 'DELETE'] : ['GET', 'PUT', 'PATCH', 'DELETE']
    try {
      const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1]
      if (!token || token.length > 1_024 || !timingSafeEqual(createHash('sha256').update(token).digest(), this.tokenDigest)) {
        response.setHeader('WWW-Authenticate', 'Bearer realm="commando-agent-hooks"')
        throw new SimLeaseError(401, 'Unauthorized')
      }
      if (!allowed.includes(request.method ?? '')) {
        response.setHeader('Allow', allowed.join(', '))
        throw new SimLeaseError(405, 'Method not allowed')
      }
      const { registry, paneExists, paneContext } = this.dependencies
      registry.list(paneExists)
      if (path === '/api/sim-leases' && request.method === 'GET') {
        writeJson(response, 200, { leases: registry.list(paneExists), ended: registry.listEnded() })
        return true
      }
      const paneId = request.headers['x-commando-pane']
      if (typeof paneId !== 'string' || !PANE_ID.test(paneId)) throw new SimLeaseError(400, 'X-Commando-Pane must be a tmux pane id')
      const target = await paneContext(paneId)
      if (!target || !paneExists(paneId)) throw new SimLeaseError(404, 'Tmux pane does not exist')
      if (path.endsWith('/context')) writeJson(response, 200, registry.context(paneId, target, paneExists))
      else {
        const body = await readJson(request)
        if (!paneExists(paneId)) throw new SimLeaseError(404, 'Tmux pane does not exist')
        if (path.endsWith('/reservation')) {
          if (request.method === 'POST') writeJson(response, 200, { operation: registry.reserve(paneId, body.udid, body.requireUnleased === true) })
          else { registry.unlock(paneId, body.operation); writeJson(response, 200, { ok: true }) }
        } else if (request.method === 'DELETE') {
          registry.delete(paneId, body.operation)
          await this.dependencies.onChange?.(paneId)
          writeJson(response, 200, { ok: true })
        } else {
          const lease = request.method === 'PUT' ? registry.upsert(paneId, target, body) : registry.touch(paneId, target, body)
          await this.dependencies.onChange?.(paneId)
          writeJson(response, 200, { lease })
        }
      }
    } catch (error) {
      writeJson(response, error instanceof SimLeaseError ? error.status : 500,
        { error: error instanceof SimLeaseError ? error.message : 'Unable to record simulator lease' })
    }
    return true
  }
}
