import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type PaneTerminalState,
  type TmuxPane,
} from '../../../shared/protocol'
import {
  decodeBase64Bytes,
  type PaneTerminalSink,
} from '../../../src/paneStream'

export type NativeTerminalEvent =
  | { kind: 'input'; data: string }
  | { kind: 'resize'; cols: number; rows: number }

export type NativeTerminalMessage =
  | {
      kind: 'frame'
      x: number
      y: number
      width: number
      height: number
      visible: boolean
      scale: number
    }
  | { kind: 'focus' }
  | {
      kind: 'reset'
      paneId: string
      data: string
      cols: number
      rows: number
      terminalState: PaneTerminalState
      revision: number
    }
  | { kind: 'data'; paneId: string; data: string; revision: number }

type SelectablePane = Pick<TmuxPane, 'id' | 'active' | 'dead'>

type SpikeTokenLocation = {
  pathname: string
  search: string
  hash: string
}

export type ResolvedSpikeToken = {
  token: string
  shouldScrub: boolean
  scrubbedUrl: string
}

export function selectLivePane<T extends SelectablePane>(
  panes: readonly T[],
  currentPaneId: string | null,
): T | null {
  const current = panes.find((pane) => pane.id === currentPaneId && !pane.dead)
  if (current) return current
  return panes.find((pane) => pane.active && !pane.dead)
    ?? panes.find((pane) => !pane.dead)
    ?? null
}

export function resolveSpikeToken(
  location: SpikeTokenLocation,
  storedToken: string,
): ResolvedSpikeToken {
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
  const fragmentParams = new URLSearchParams(fragment)
  const hasFragmentParameter = fragmentParams.has('token')
  const hasRawFragmentToken = Boolean(fragment && !fragment.includes('=') && !hasFragmentParameter)
  const hasFragmentToken = hasFragmentParameter || hasRawFragmentToken
  let fragmentToken = fragmentParams.get('token') ?? ''
  if (!fragmentToken && hasRawFragmentToken) {
    try {
      fragmentToken = decodeURIComponent(fragment)
    } catch {
      fragmentToken = fragment
    }
  }

  const queryParams = new URLSearchParams(location.search)
  const hasQueryToken = queryParams.has('token')
  const queryToken = queryParams.get('token') ?? ''
  if (hasQueryToken) queryParams.delete('token')

  const scrubbedSearch = hasQueryToken
    ? queryParams.size > 0 ? `?${queryParams.toString()}` : ''
    : location.search
  return {
    token: fragmentToken || queryToken || storedToken,
    shouldScrub: hasFragmentToken || hasQueryToken,
    scrubbedUrl: `${location.pathname}${scrubbedSearch}`,
  }
}

export function encodeBase64Bytes(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return globalThis.btoa(binary)
}

export function parseNativeTerminalEvent(value: unknown): NativeTerminalEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'input' && typeof candidate.data === 'string') {
    return { kind: 'input', data: candidate.data }
  }
  if (
    candidate.kind === 'resize'
    && Number.isSafeInteger(candidate.cols)
    && Number.isSafeInteger(candidate.rows)
    && (candidate.cols as number) > 0
    && (candidate.rows as number) > 0
  ) {
    return {
      kind: 'resize',
      cols: candidate.cols as number,
      rows: candidate.rows as number,
    }
  }
  return null
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function decodeNativeInput(data: string): string | null {
  if (!data || !BASE64_PATTERN.test(data)) return null
  try {
    const bytes = decodeBase64Bytes(data)
    if (encodeBase64Bytes(bytes) !== data) return null
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return decoded && !decoded.includes('\0') ? decoded : null
  } catch {
    return null
  }
}

export function chunkTerminalInput(data: string): string[] {
  const characters = [...data]
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += 1_024) {
    chunks.push(characters.slice(index, index + 1_024).join(''))
  }
  return chunks
}

export function boundedTerminalSize(
  event: Extract<NativeTerminalEvent, { kind: 'resize' }>,
): { cols: number; rows: number } {
  return {
    cols: Math.min(MAX_TERMINAL_COLS, Math.max(MIN_TERMINAL_COLS, event.cols)),
    rows: Math.min(MAX_TERMINAL_ROWS, Math.max(MIN_TERMINAL_ROWS, event.rows)),
  }
}

export function createNativeTerminalSink(
  paneId: string,
  postMessage: (message: NativeTerminalMessage) => void,
): PaneTerminalSink {
  return {
    reset: (message) => postMessage({
      kind: 'reset',
      paneId,
      data: encodeBase64Bytes(message.data),
      cols: message.cols,
      rows: message.rows,
      terminalState: message.terminalState,
      revision: message.revision,
    }),
    write: (data, revision) => postMessage({
      kind: 'data',
      paneId,
      data: encodeBase64Bytes(data),
      revision,
    }),
  }
}
