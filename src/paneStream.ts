import type { PaneTerminalState } from '../shared/protocol'

export type PaneReset = {
  data: Uint8Array
  cols: number
  rows: number
  terminalState: PaneTerminalState
  revision: number
}

export type PaneTerminalSink = {
  reset: (message: PaneReset) => void
  write: (data: Uint8Array, revision: number) => void
}

type PendingData = {
  data: Uint8Array
  revision: number
}

type PaneStreamState = {
  sink?: PaneTerminalSink
  awaitingReset: boolean
  lastRevision: number
  pendingReset?: PaneReset
  pendingData: PendingData[]
  pendingBytes: number
  expiresAt: number
}

const BUFFER_TTL_MS = 5_000
const MAX_BUFFERED_BYTES = 5 * 1024 * 1024

export function decodeBase64Bytes(data: string): Uint8Array {
  const binary = globalThis.atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export class PaneStreamRegistry {
  private readonly streams = new Map<string, PaneStreamState>()

  constructor(private readonly now: () => number = Date.now) {}

  register(paneId: string, sink: PaneTerminalSink): () => void {
    const state = this.getState(paneId)
    state.sink = sink
    this.expirePending(state)
    this.flush(state)

    return () => {
      const current = this.streams.get(paneId)
      if (!current || current.sink !== sink) return
      current.sink = undefined
      current.awaitingReset = true
      this.clearPending(current)
    }
  }

  pushReset(paneId: string, message: PaneReset): boolean {
    const state = this.getState(paneId)
    this.expirePending(state)
    if (message.revision < state.lastRevision) return false

    state.lastRevision = message.revision
    state.awaitingReset = true
    state.pendingReset = message
    state.pendingData = state.pendingData.filter(
      (pending) => pending.revision > message.revision,
    )
    state.pendingBytes = message.data.byteLength + state.pendingData.reduce(
      (total, pending) => total + pending.data.byteLength,
      0,
    )
    state.expiresAt = this.now() + BUFFER_TTL_MS
    this.enforceBufferLimit(state)
    this.flush(state)
    return true
  }

  pushData(paneId: string, data: Uint8Array, revision: number): boolean {
    const state = this.getState(paneId)
    this.expirePending(state)
    if (revision <= state.lastRevision) return false

    state.lastRevision = revision
    if (state.sink && !state.awaitingReset) {
      state.sink.write(data, revision)
      return true
    }

    state.pendingData.push({ data, revision })
    state.pendingBytes += data.byteLength
    state.expiresAt = this.now() + BUFFER_TTL_MS
    this.enforceBufferLimit(state)
    return true
  }

  clear(): void {
    for (const [paneId, state] of this.streams) {
      if (!state.sink) {
        this.streams.delete(paneId)
        continue
      }
      state.awaitingReset = true
      state.lastRevision = Number.NEGATIVE_INFINITY
      this.clearPending(state)
    }
  }

  private getState(paneId: string): PaneStreamState {
    const existing = this.streams.get(paneId)
    if (existing) return existing

    const state: PaneStreamState = {
      awaitingReset: true,
      lastRevision: Number.NEGATIVE_INFINITY,
      pendingData: [],
      pendingBytes: 0,
      expiresAt: 0,
    }
    this.streams.set(paneId, state)
    return state
  }

  private flush(state: PaneStreamState): void {
    if (!state.sink || !state.pendingReset) return

    const reset = state.pendingReset
    const data = state.pendingData
    this.clearPending(state)
    state.awaitingReset = false
    state.sink.reset(reset)
    for (const pending of data) {
      if (pending.revision > reset.revision) {
        state.sink.write(pending.data, pending.revision)
      }
    }
  }

  private expirePending(state: PaneStreamState): void {
    if (state.expiresAt && state.expiresAt <= this.now()) {
      state.awaitingReset = true
      this.clearPending(state)
    }
  }

  private enforceBufferLimit(state: PaneStreamState): void {
    if (state.pendingBytes <= MAX_BUFFERED_BYTES) return
    state.awaitingReset = true
    this.clearPending(state)
  }

  private clearPending(state: PaneStreamState): void {
    state.pendingReset = undefined
    state.pendingData = []
    state.pendingBytes = 0
    state.expiresAt = 0
  }
}
