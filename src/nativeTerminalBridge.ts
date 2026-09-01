import { MAX_PASTE_BYTES, MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from '../shared/protocol'

export const NATIVE_TERMINAL_PROTOCOL = 'commando.native-terminal' as const
export const NATIVE_TERMINAL_VERSION = 1 as const
export const NATIVE_TERMINAL_SHORTCUT_EVENT = 'commando:native-terminal-shortcut'
export const NATIVE_TERMINAL_KEY_SHORTCUTS = ['Meta+C', 'Meta+V', 'PageUp', 'PageDown'] as const
export const NATIVE_TERMINAL_FRAME_LIMITS = {
  maxCoordinate: 32_768,
  maxDimension: 16_384,
  minScale: 0.25,
  maxScale: 8,
  maxVisibleRegions: 64,
} as const

export const NATIVE_TERMINAL_EVENT_LIMITS = {
  maxInputBytes: 8 * 1_024,
  minCols: 2,
  maxCols: MAX_TERMINAL_COLS,
  minRows: 1,
  maxRows: MAX_TERMINAL_ROWS,
} as const

export const REQUIRED_NATIVE_TERMINAL_CAPABILITIES = [
  'terminal.multiPane.v1',
  'terminal.binaryInput.v1',
  'terminal.cssPixelGeometry.v1',
  'terminal.attachmentLifecycle.v1',
  'terminal.visibleRegions.v1',
  'terminal.metadataUpdates.v1',
  'terminal.pasteText.v1',
  'terminal.selectionCopy.v1',
  'terminal.contextMenu.v1',
  'terminal.accessibilityValue.v1',
] as const

export type NativeTerminalVisibleRegion = {
  x: number
  y: number
  width: number
  height: number
}

export type NativeTerminalFramePayload = {
  x: number
  y: number
  width: number
  height: number
  scale: number
  visible: boolean
  visibleRegions: NativeTerminalVisibleRegion[]
  hitRegions?: NativeTerminalVisibleRegion[]
  resizeOwner: boolean
  order: number
}

export const NATIVE_TERMINAL_HIT_REGIONS_CAPABILITY = 'terminal.hitRegions.v1'

type NativeMessageHandler = {
  postMessage: (message: NativeTerminalMessage) => void
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        commandoNativeTerminal?: NativeMessageHandler
      }
    }
    __commandoNativeTerminalReceive?: (event: unknown) => void
  }
}

export type NativeTerminalMessage = {
  protocol: typeof NATIVE_TERMINAL_PROTOCOL
  version: typeof NATIVE_TERMINAL_VERSION
  pageId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
}

type PaneIdentity = {
  paneId: string
  attachmentId: string
}

export type NativeTerminalMetadata = {
  ariaLabel: string
  accessibilityEnabled: boolean
  keyShortcuts: string[]
}

export type NativeTerminalAttachmentEvent =
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.attached'; payload: PaneIdentity }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.seeded'; payload: PaneIdentity & { revision: number } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.input_bytes'; payload: PaneIdentity & { data: string } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.paste_text'; payload: PaneIdentity & { data: string } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.resize'; payload: PaneIdentity & { cols: number; rows: number } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.focus_changed'; payload: PaneIdentity & { focused: boolean } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.selection_copied'; payload: PaneIdentity }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.context_menu'; payload: PaneIdentity & { x: number; y: number } }
  | { version: 1; pageId: string; eventSequence: number; type: 'pane.detached'; payload: PaneIdentity }
  | {
      version: 1
      pageId: string
      eventSequence: number
      type: 'pane.failed'
      payload: { paneId?: string; attachmentId?: string; code: string; fatal: boolean }
    }

type NativeTerminalBridgeEvent =
  | {
      version: 1
      pageId: string
      eventSequence: number
      type: 'bridge.connected'
      payload: { capabilities: string[]; maxPanes: number }
    }
  | {
      version: 1
      pageId: string
      eventSequence: number
      type: 'bridge.rejected'
      payload: { reason: string; paneId?: string; attachmentId?: string }
    }
  | NativeTerminalAttachmentEvent
  | {
      version: 1
      pageId: string
      eventSequence: number
      type: 'host.shortcut'
      payload: { key: 'k' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'; metaKey: true }
    }

export type NativeTerminalNegotiation =
  | { available: true; capabilities: string[]; maxPanes: number }
  | { available: false; reason: string }

export type NativeTerminalAttachment = {
  attachmentId: string
  ready: Promise<void>
  detach: () => void
}

type AttachmentRecord = {
  paneId: string
  attachmentId: string
  listener: (event: NativeTerminalAttachmentEvent) => void
  resolve: () => void
  reject: (reason: Error) => void
  settled: boolean
  timer: number
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const DEFAULT_ATTACH_TIMEOUT_MS = 1_000

function createPageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const PAGE_ID = createPageId()

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isFrameCoordinate(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= NATIVE_TERMINAL_FRAME_LIMITS.maxCoordinate
}

function isFrameDimension(value: unknown, allowsZero: boolean): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    (allowsZero ? value >= 0 : value > 0) &&
    value <= NATIVE_TERMINAL_FRAME_LIMITS.maxDimension
}

function isFrameRegionList(value: unknown): value is NativeTerminalVisibleRegion[] {
  return Array.isArray(value) &&
    value.length <= NATIVE_TERMINAL_FRAME_LIMITS.maxVisibleRegions &&
    value.every((region) => (
      isFrameCoordinate(region.x) &&
      isFrameCoordinate(region.y) &&
      isFrameDimension(region.width, false) &&
      isFrameDimension(region.height, false)
    ))
}

export function isNativeTerminalFramePayload(value: NativeTerminalFramePayload): boolean {
  return isFrameCoordinate(value.x) &&
    isFrameCoordinate(value.y) &&
    isFrameDimension(value.width, true) &&
    isFrameDimension(value.height, true) &&
    Number.isFinite(value.scale) &&
    value.scale >= NATIVE_TERMINAL_FRAME_LIMITS.minScale &&
    value.scale <= NATIVE_TERMINAL_FRAME_LIMITS.maxScale &&
    typeof value.visible === 'boolean' &&
    isFrameRegionList(value.visibleRegions) &&
    (value.hitRegions === undefined || isFrameRegionList(value.hitRegions)) &&
    typeof value.resizeOwner === 'boolean' &&
    Number.isSafeInteger(value.order)
}

function isClientCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000
}

function isBoundedPasteText(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= MAX_PASTE_BYTES
}

function isCanonicalBase64WithinBytes(value: unknown, maximumBytes: number): value is string {
  return typeof value === 'string' &&
    value.length <= Math.ceil(maximumBytes / 3) * 4 &&
    isCanonicalBase64(value) &&
    globalThis.atob(value).length <= maximumBytes
}

export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  try {
    return globalThis.btoa(globalThis.atob(value)) === value
  } catch {
    return false
  }
}

export function encodeBase64Bytes(data: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 32_768) {
    const chunk = data.subarray(offset, offset + 32_768)
    binary += String.fromCharCode(...chunk)
  }
  return globalThis.btoa(binary)
}

function paneIdentity(payload: Record<string, unknown>, extraKeys: readonly string[] = []): payload is Record<string, unknown> & PaneIdentity {
  return hasOnlyKeys(payload, ['paneId', 'attachmentId', ...extraKeys]) &&
    isNonEmptyString(payload.paneId) &&
    isNonEmptyString(payload.attachmentId)
}

function validatePayload(type: string, payload: Record<string, unknown>): boolean {
  switch (type) {
    case 'bridge.connected':
      return hasOnlyKeys(payload, ['capabilities', 'maxPanes']) &&
        Array.isArray(payload.capabilities) &&
        payload.capabilities.every(isNonEmptyString) &&
        isInteger(payload.maxPanes, 1)
    case 'bridge.rejected':
      return hasOnlyKeys(payload, ['reason', 'paneId', 'attachmentId']) &&
        isNonEmptyString(payload.reason) &&
        ((payload.paneId === undefined && payload.attachmentId === undefined) ||
          (isNonEmptyString(payload.paneId) && isNonEmptyString(payload.attachmentId)))
    case 'pane.attached':
    case 'pane.detached':
      return paneIdentity(payload)
    case 'pane.seeded':
      return paneIdentity(payload, ['revision']) && isInteger(payload.revision)
    case 'pane.input_bytes':
      return paneIdentity(payload, ['data']) &&
        isCanonicalBase64WithinBytes(payload.data, NATIVE_TERMINAL_EVENT_LIMITS.maxInputBytes)
    case 'pane.paste_text':
      return paneIdentity(payload, ['data']) && isBoundedPasteText(payload.data)
    case 'pane.resize':
      return paneIdentity(payload, ['cols', 'rows']) &&
        isInteger(payload.cols, NATIVE_TERMINAL_EVENT_LIMITS.minCols) &&
        payload.cols <= NATIVE_TERMINAL_EVENT_LIMITS.maxCols &&
        isInteger(payload.rows, NATIVE_TERMINAL_EVENT_LIMITS.minRows) &&
        payload.rows <= NATIVE_TERMINAL_EVENT_LIMITS.maxRows
    case 'pane.focus_changed':
      return paneIdentity(payload, ['focused']) && typeof payload.focused === 'boolean'
    case 'pane.selection_copied':
      return paneIdentity(payload)
    case 'pane.context_menu':
      return paneIdentity(payload, ['x', 'y']) &&
        isClientCoordinate(payload.x) &&
        isClientCoordinate(payload.y)
    case 'pane.failed':
      return hasOnlyKeys(payload, ['paneId', 'attachmentId', 'code', 'fatal']) &&
        (payload.paneId === undefined || isNonEmptyString(payload.paneId)) &&
        (payload.attachmentId === undefined || isNonEmptyString(payload.attachmentId)) &&
        isNonEmptyString(payload.code) &&
        typeof payload.fatal === 'boolean'
    case 'host.shortcut':
      return hasOnlyKeys(payload, ['key', 'metaKey']) &&
        typeof payload.key === 'string' &&
        /^(?:k|[1-9])$/.test(payload.key) &&
        payload.metaKey === true
    default:
      return false
  }
}

function validateEvent(value: unknown): NativeTerminalBridgeEvent | null {
  if (!isObject(value) || !hasOnlyKeys(value, ['version', 'pageId', 'eventSequence', 'type', 'payload'])) return null
  if (
    value.version !== NATIVE_TERMINAL_VERSION ||
    !isNonEmptyString(value.pageId) ||
    !isInteger(value.eventSequence, 1) ||
    !isNonEmptyString(value.type) ||
    !isObject(value.payload) ||
    !validatePayload(value.type, value.payload)
  ) return null
  return value as NativeTerminalBridgeEvent
}

function messageHandler(): NativeMessageHandler | null {
  try {
    const handler = window.webkit?.messageHandlers?.commandoNativeTerminal
    return handler && typeof handler.postMessage === 'function' ? handler : null
  } catch {
    return null
  }
}

export function hasNativeTerminalHandler(): boolean {
  return messageHandler() !== null
}

export class NativeTerminalBridge {
  readonly pageId = PAGE_ID

  private sequence = 0
  private lastEventSequence = 0
  private negotiation?: Promise<NativeTerminalNegotiation>
  private finishNegotiation?: (result: NativeTerminalNegotiation) => void
  private handshakeTimer?: number
  private connected = false
  private maxPanes = 0
  private hitRegionsSupported = false
  private readonly attachments = new Map<string, AttachmentRecord>()
  private readonly shortcutListeners = new Set<(key: 'k' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9') => void>()
  private readonly previousReceiver = window.__commandoNativeTerminalReceive
  private readonly receiver = (value: unknown) => this.receive(value)

  constructor(
    private readonly handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    private readonly attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS,
  ) {
    window.__commandoNativeTerminalReceive = this.receiver
  }

  connect(): Promise<NativeTerminalNegotiation> {
    if (this.negotiation) return this.negotiation
    if (!messageHandler()) {
      this.negotiation = Promise.resolve({ available: false, reason: 'handler-absent' })
      return this.negotiation
    }

    this.negotiation = new Promise((resolve) => {
      this.finishNegotiation = resolve
      this.handshakeTimer = window.setTimeout(() => {
        this.completeNegotiation({ available: false, reason: 'handshake-timeout' })
      }, this.handshakeTimeoutMs)
      if (!this.post('bridge.connect', { supportedVersions: [NATIVE_TERMINAL_VERSION] })) {
        this.completeNegotiation({ available: false, reason: 'handler-unavailable' })
      }
    })
    return this.negotiation
  }

  attach(
    paneId: string,
    attachmentId: string,
    metadata: NativeTerminalMetadata,
    listener: (event: NativeTerminalAttachmentEvent) => void,
  ): NativeTerminalAttachment {
    if (!this.connected) throw new Error('Native terminal bridge is not connected')
    if (this.attachments.size >= this.maxPanes) throw new Error('Native terminal pane limit reached')
    if (this.attachments.has(attachmentId)) throw new Error('Native terminal attachment already exists')

    let resolveReady: () => void = () => {}
    let rejectReady: (reason: Error) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const record: AttachmentRecord = {
      paneId,
      attachmentId,
      listener,
      resolve: resolveReady,
      reject: rejectReady,
      settled: false,
      timer: 0,
    }
    this.attachments.set(attachmentId, record)
    record.timer = window.setTimeout(() => {
      if (this.attachments.get(attachmentId) !== record) return
      this.attachments.delete(attachmentId)
      record.settled = true
      record.reject(new Error('Native terminal attach timed out'))
      this.post('pane.detach', { paneId, attachmentId })
    }, this.attachTimeoutMs)

    if (!this.post('pane.attach', { paneId, attachmentId, ...metadata })) {
      this.attachments.delete(attachmentId)
      window.clearTimeout(record.timer)
      record.settled = true
      record.reject(new Error('Native terminal handler became unavailable'))
    }

    return {
      attachmentId,
      ready,
      detach: () => this.detachRecord(record),
    }
  }

  frame(attachmentId: string, payload: NativeTerminalFramePayload): boolean {
    if (!isNativeTerminalFramePayload(payload)) return false
    if (!this.hitRegionsSupported || payload.hitRegions === undefined) {
      const { hitRegions: _hitRegions, ...supported } = payload
      return this.postForAttachment('pane.frame', attachmentId, supported)
    }
    return this.postForAttachment('pane.frame', attachmentId, payload)
  }

  focus(attachmentId: string): boolean {
    return this.postForAttachment('pane.focus', attachmentId, {})
  }

  updateMetadata(attachmentId: string, metadata: NativeTerminalMetadata): boolean {
    return this.postForAttachment('pane.update', attachmentId, metadata)
  }

  reset(attachmentId: string, payload: {
    data: string
    cols: number
    rows: number
    revision: number
  }): boolean {
    return this.postForAttachment('pane.reset', attachmentId, payload)
  }

  data(attachmentId: string, data: string, revision: number): boolean {
    return this.postForAttachment('pane.data', attachmentId, { data, revision })
  }

  subscribeHostShortcuts(
    listener: (key: 'k' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9') => void,
  ): () => void {
    this.shortcutListeners.add(listener)
    return () => this.shortcutListeners.delete(listener)
  }

  dispose(): void {
    if (this.handshakeTimer !== undefined) window.clearTimeout(this.handshakeTimer)
    for (const record of [...this.attachments.values()]) this.detachRecord(record)
    if (window.__commandoNativeTerminalReceive === this.receiver) {
      window.__commandoNativeTerminalReceive = this.previousReceiver
    }
  }

  private post(type: string, payload: Record<string, unknown>): boolean {
    const handler = messageHandler()
    if (!handler) return false
    try {
      this.sequence += 1
      handler.postMessage({
        protocol: NATIVE_TERMINAL_PROTOCOL,
        version: NATIVE_TERMINAL_VERSION,
        pageId: this.pageId,
        sequence: this.sequence,
        type,
        payload,
      })
      return true
    } catch {
      return false
    }
  }

  private postForAttachment(type: string, attachmentId: string, payload: Record<string, unknown>): boolean {
    const record = this.attachments.get(attachmentId)
    if (!record) return false
    return this.post(type, { paneId: record.paneId, attachmentId, ...payload })
  }

  private detachRecord(record: AttachmentRecord): void {
    if (this.attachments.get(record.attachmentId) !== record) return
    this.attachments.delete(record.attachmentId)
    window.clearTimeout(record.timer)
    if (!record.settled) {
      record.settled = true
      record.reject(new Error('Native terminal attachment detached'))
    }
    this.post('pane.detach', { paneId: record.paneId, attachmentId: record.attachmentId })
  }

  private completeNegotiation(result: NativeTerminalNegotiation): void {
    if (!this.finishNegotiation) return
    if (this.handshakeTimer !== undefined) window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    const finish = this.finishNegotiation
    this.finishNegotiation = undefined
    this.connected = result.available
    this.maxPanes = result.available ? result.maxPanes : 0
    this.hitRegionsSupported = result.available &&
      result.capabilities.includes(NATIVE_TERMINAL_HIT_REGIONS_CAPABILITY)
    finish(result)
  }

  private receive(value: unknown): void {
    if (
      isObject(value) &&
      value.pageId === this.pageId &&
      typeof value.version === 'number' &&
      value.version !== NATIVE_TERMINAL_VERSION
    ) {
      this.completeNegotiation({ available: false, reason: 'version-mismatch' })
      return
    }

    const event = validateEvent(value)
    if (!event || event.pageId !== this.pageId || event.eventSequence <= this.lastEventSequence) return
    this.lastEventSequence = event.eventSequence

    if (event.type === 'bridge.connected') {
      const missing = REQUIRED_NATIVE_TERMINAL_CAPABILITIES.filter(
        (capability) => !event.payload.capabilities.includes(capability),
      )
      this.completeNegotiation(missing.length
        ? { available: false, reason: 'missing-capabilities' }
        : {
            available: true,
            capabilities: [...event.payload.capabilities],
            maxPanes: event.payload.maxPanes,
          })
      return
    }
    if (event.type === 'bridge.rejected') {
      if (!this.connected) {
        this.completeNegotiation({ available: false, reason: event.payload.reason })
        return
      }
      const attachmentId = event.payload.attachmentId
      if (!attachmentId) return
      const record = this.attachments.get(attachmentId)
      if (!record || event.payload.paneId !== record.paneId) return
      window.clearTimeout(record.timer)
      if (!record.settled) {
        record.settled = true
        record.reject(new Error(`Native terminal command rejected: ${event.payload.reason}`))
      }
      record.listener({
        version: event.version,
        pageId: event.pageId,
        eventSequence: event.eventSequence,
        type: 'pane.failed',
        payload: {
          paneId: record.paneId,
          attachmentId: record.attachmentId,
          code: event.payload.reason,
          fatal: false,
        },
      })
      return
    }
    if (!this.connected) return

    if (event.type === 'host.shortcut') {
      for (const listener of this.shortcutListeners) listener(event.payload.key)
      window.dispatchEvent(new CustomEvent(NATIVE_TERMINAL_SHORTCUT_EVENT, {
        detail: { key: event.payload.key, metaKey: true },
      }))
      return
    }

    if (event.type === 'pane.failed' && !event.payload.attachmentId) {
      for (const record of this.attachments.values()) {
        if (event.payload.paneId && event.payload.paneId !== record.paneId) continue
        record.listener(event)
      }
      return
    }

    const attachmentId = event.payload.attachmentId
    if (!attachmentId) return
    const record = this.attachments.get(attachmentId)
    if (!record || ('paneId' in event.payload && event.payload.paneId !== record.paneId)) return

    if (event.type === 'pane.attached' && !record.settled) {
      window.clearTimeout(record.timer)
      record.settled = true
      record.resolve()
    } else if (event.type === 'pane.detached') {
      this.attachments.delete(record.attachmentId)
      window.clearTimeout(record.timer)
      if (!record.settled) {
        record.settled = true
        record.reject(new Error('Native terminal detached before attach completed'))
      }
    }
    record.listener(event)
  }
}

let sharedBridge: NativeTerminalBridge | undefined

export function getNativeTerminalBridge(): NativeTerminalBridge | null {
  if (!hasNativeTerminalHandler()) return null
  sharedBridge ??= new NativeTerminalBridge()
  return sharedBridge
}

export function resetNativeTerminalBridge(): void {
  sharedBridge?.dispose()
  sharedBridge = undefined
}
