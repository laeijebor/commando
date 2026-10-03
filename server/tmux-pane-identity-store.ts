import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isCommandoTargetId } from '../shared/pane-target.js'
import { parseStoredPaneTarget, type PaneTargetObservation } from './tmux-pane-targets.js'

export type PaneIdentityObservation = PaneTargetObservation & {
  sessionName: string
  windowIndex: number
  paneIndex: number
  path: string
}
type Binding = Omit<PaneIdentityObservation, 'storedValue'> & { targetId: string; serverId: string }
const MAX_BINDINGS = 1024

export function defaultPaneIdentityPath(): string {
  if (process.env.COMMANDO_PANE_IDENTITIES_PATH) return process.env.COMMANDO_PANE_IDENTITIES_PATH
  const socket = process.env.COMMANDO_TMUX_SOCKET_PATH
    ? `path:${process.env.COMMANDO_TMUX_SOCKET_PATH}`
    : process.env.COMMANDO_TMUX_SOCKET_NAME && process.env.COMMANDO_TMUX_SOCKET_NAME !== 'default'
      ? `name:${process.env.COMMANDO_TMUX_SOCKET_NAME}` : undefined
  const suffix = socket ? `-${createHash('sha256').update(socket).digest('hex').slice(0, 16)}` : ''
  return join(homedir(), '.commando', `pane-identities${suffix}.json`)
}

function slot(pane: Pick<Binding, 'sessionName' | 'windowIndex' | 'paneIndex'>): string {
  return JSON.stringify([pane.sessionName, pane.windowIndex, pane.paneIndex])
}

function validBinding(value: unknown): value is Binding {
  if (!value || typeof value !== 'object') return false
  const binding = value as Binding
  return /^%\d+$/.test(binding.paneId) && isCommandoTargetId(binding.targetId)
    && /^\d+:\d+$/.test(binding.serverId) && typeof binding.sessionName === 'string'
    && binding.sessionName.length > 0 && binding.sessionName.length <= 128
    && Number.isSafeInteger(binding.windowIndex) && binding.windowIndex >= 0
    && Number.isSafeInteger(binding.paneIndex) && binding.paneIndex >= 0
    && typeof binding.path === 'string' && binding.path.startsWith('/') && !binding.path.includes('\0')
}

/** tmux-resurrect restores slots and cwd, but not @commando_target or numeric pane IDs. */
export class TmuxPaneIdentityStore {
  private bindings: Binding[] = []
  private loaded = false

  constructor(readonly statePath = defaultPaneIdentityPath()) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (state.version !== 1 || !Array.isArray(state.bindings) || state.bindings.length > MAX_BINDINGS
        || !state.bindings.every(validBinding)) throw new Error('Invalid pane identity state')
      this.bindings = state.bindings
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.loaded = true
  }

  async restore(serverId: string, observations: readonly PaneIdentityObservation[], persist: (paneId: string, value: string) => Promise<void>): Promise<PaneIdentityObservation[]> {
    await this.load()
    if (!/^\d+:\d+$/.test(serverId)) throw new Error('Invalid tmux server identity')
    const used = new Set(observations.flatMap((pane) => {
      const target = parseStoredPaneTarget(pane.storedValue, pane.paneId)
      return target ? [target] : []
    }))
    const result: PaneIdentityObservation[] = []
    for (const pane of observations) {
      // Malformed/inherited options must be repaired, not treated as restoration evidence.
      if (pane.storedValue) { result.push(pane); continue }
      const candidates = this.bindings.filter((binding) => slot(binding) === slot(pane))
      const matching = candidates.filter((binding) => binding.path === pane.path && binding.serverId !== serverId)
      const previous = matching.length === 1 && !candidates.some((binding) => binding.serverId === serverId) ? matching[0] : undefined
      if (!previous || used.has(previous.targetId) || observations.filter((other) => slot(other) === slot(pane)).length !== 1) {
        result.push(pane)
        continue
      }
      const storedValue = `v1:${pane.paneId}:${previous.targetId}`
      await persist(pane.paneId, storedValue)
      used.add(previous.targetId)
      result.push({ ...pane, storedValue })
    }
    return result
  }

  async remember(serverId: string, observations: readonly PaneIdentityObservation[], targets: ReadonlyMap<string, string>): Promise<void> {
    await this.load()
    const next = [...this.bindings]
    for (const pane of observations) {
      const targetId = targets.get(pane.paneId)
      if (!targetId) continue
      // Keep absent slots for incremental resurrection; replace occupied slots and moved targets.
      for (let index = next.length - 1; index >= 0; index--) {
        if (next[index].targetId === targetId || slot(next[index]) === slot(pane)) next.splice(index, 1)
      }
      const { storedValue: _value, ...identity } = pane
      next.push({ ...identity, targetId, serverId })
    }
    next.splice(0, Math.max(0, next.length - MAX_BINDINGS))
    // Discovery order should not cause a disk write on every poll.
    next.sort((left, right) => left.targetId.localeCompare(right.targetId))
    if (JSON.stringify(next) === JSON.stringify(this.bindings)) return
    await this.write(next)
    this.bindings = next
  }

  private async write(bindings: Binding[]): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.statePath}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, bindings }, null, 2)}\n`)
      await handle.sync()
      await handle.close()
      await rename(temporary, this.statePath)
      try {
        const directory = await open(dirname(this.statePath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch {
        // Some platforms do not support directory fsync.
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
