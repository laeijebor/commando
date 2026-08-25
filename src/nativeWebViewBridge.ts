import type { NativeTerminalFramePayload } from './nativeTerminalBridge'
import { isNativeTerminalFramePayload } from './nativeTerminalBridge'
import {
  MAX_INSPECT_SELECTOR,
  MAX_SELECTOR_RESOLVE_BYTES,
  MAX_SELECTOR_RESOLVE_ITEMS,
  parseTileInspectResult,
  parseTileSelectorAnchors,
  type TileInspectGrade,
  type TileInspectResult,
  type TileSelectorAnchor,
  type TileSelectorResolveItem,
} from '../shared/tile-inspect'

/**
 * Bridge to the desktop shell's native web-view tier. WebKit panes use it for
 * external origins that refuse framing; Chromium panes can also use it as an
 * experimental, client-local visible surface. A small sibling of the native
 * terminal bridge with the same envelope shape.
 */
export const NATIVE_WEBVIEW_PROTOCOL = 'commando.native-webview' as const
export const NATIVE_WEBVIEW_VERSION = 1 as const
export const REQUIRED_NATIVE_WEBVIEW_CAPABILITIES = ['webview.embed.v1'] as const
export const NATIVE_WEBVIEW_INSPECT_CAPABILITY = 'webview.inspectAtPoint.v1' as const
export const NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY = 'webview.resolveSelectors.v1' as const

type NativeMessageHandler = {
  postMessage: (message: Record<string, unknown>) => void
}

declare global {
  interface Window {
    __commandoNativeWebViewReceive?: (event: unknown) => void
  }
}

export type NativeWebViewNegotiation =
  | { available: true; capabilities: string[]; maxWebViews: number }
  | { available: false; reason: string }

export type NativeWebViewTileEvent =
  | { type: 'webview.attached' }
  | { type: 'webview.loaded' }
  | { type: 'webview.failed'; code: string }

export type NativeWebViewAttachment = {
  attachmentId: string
  inspectAtPoint: (x: number, y: number, grade: TileInspectGrade) => Promise<TileInspectResult>
  resolveSelectors: (items: readonly TileSelectorResolveItem[]) => Promise<TileSelectorAnchor[]>
  detach: () => void
}

type AttachmentRecord = {
  webPaneId: string
  attachmentId: string
  listener: (event: NativeWebViewTileEvent) => void
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const INSPECTION_TIMEOUT_MS = 5_000
const MAX_INSPECTION_COORDINATE = 100_000
const MAX_PENDING_INSPECTIONS = 32

type PendingInspect = {
  attachmentId: string
  resolve: (result: TileInspectResult) => void
  reject: (error: Error) => void
  timer: number
}

type PendingResolve = {
  attachmentId: string
  requestedNoteIds: ReadonlySet<number>
  resolve: (anchors: TileSelectorAnchor[]) => void
  reject: (error: Error) => void
  timer: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function messageHandler(): NativeMessageHandler | null {
  try {
    // Window.webkit is declared by nativeTerminalBridge without this handler;
    // read it through a local cast instead of re-augmenting the global type.
    const handlers = (window as unknown as {
      webkit?: { messageHandlers?: { commandoNativeWebView?: NativeMessageHandler } }
    }).webkit?.messageHandlers
    const handler = handlers?.commandoNativeWebView
    return handler && typeof handler.postMessage === 'function' ? handler : null
  } catch {
    return null
  }
}

export function hasNativeWebViewHandler(): boolean {
  return messageHandler() !== null
}

function createPageId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

let attachmentSequence = 0

export class NativeWebViewBridge {
  readonly pageId = createPageId()

  private sequence = 0
  private lastEventSequence = 0
  private negotiation?: Promise<NativeWebViewNegotiation>
  private finishNegotiation?: (result: NativeWebViewNegotiation) => void
  private handshakeTimer?: number
  private connected = false
  private maxWebViews = 0
  private capabilities = new Set<string>()
  private readonly attachments = new Map<string, AttachmentRecord>()
  private requestSequence = 0
  private readonly pendingInspects = new Map<string, PendingInspect>()
  private readonly pendingResolves = new Map<string, PendingResolve>()
  private readonly previousReceiver = window.__commandoNativeWebViewReceive
  private readonly receiver = (value: unknown) => this.receive(value)

  constructor(private readonly handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS) {
    window.__commandoNativeWebViewReceive = this.receiver
  }

  connect(): Promise<NativeWebViewNegotiation> {
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
      if (!this.post('bridge.connect', { supportedVersions: [NATIVE_WEBVIEW_VERSION] })) {
        this.completeNegotiation({ available: false, reason: 'handler-unavailable' })
      }
    })
    return this.negotiation
  }

  attach(
    webPaneId: string,
    url: string,
    listener: (event: NativeWebViewTileEvent) => void,
  ): NativeWebViewAttachment {
    if (!this.connected) throw new Error('Native web view bridge is not connected')
    if (this.attachments.size >= this.maxWebViews) throw new Error('Native web view limit reached')
    attachmentSequence += 1
    const attachmentId = `${this.pageId}:${attachmentSequence}`
    const record: AttachmentRecord = { webPaneId, attachmentId, listener }
    this.attachments.set(attachmentId, record)
    if (!this.post('webview.attach', { webPaneId, attachmentId, url })) {
      this.attachments.delete(attachmentId)
      throw new Error('Native web view handler became unavailable')
    }
    return {
      attachmentId,
      inspectAtPoint: (x, y, grade) => this.inspectAtPoint(attachmentId, x, y, grade),
      resolveSelectors: (items) => this.resolveSelectors(attachmentId, items),
      detach: () => {
        if (this.attachments.delete(attachmentId)) {
          this.rejectPendingForAttachment(attachmentId, 'Native web view attachment detached')
          this.post('webview.detach', { webPaneId, attachmentId })
        }
      },
    }
  }

  frame(attachmentId: string, payload: NativeTerminalFramePayload): boolean {
    if (!isNativeTerminalFramePayload(payload)) return false
    return this.postForAttachment('webview.frame', attachmentId, payload)
  }

  reload(attachmentId: string): boolean {
    return this.postForAttachment('webview.reload', attachmentId, {})
  }

  dispose(): void {
    if (this.handshakeTimer !== undefined) window.clearTimeout(this.handshakeTimer)
    this.rejectAllPending('Native web view bridge disposed')
    for (const record of [...this.attachments.values()]) {
      this.attachments.delete(record.attachmentId)
      this.post('webview.detach', {
        webPaneId: record.webPaneId,
        attachmentId: record.attachmentId,
      })
    }
    if (window.__commandoNativeWebViewReceive === this.receiver) {
      window.__commandoNativeWebViewReceive = this.previousReceiver
    }
  }

  private post(type: string, payload: Record<string, unknown>): boolean {
    const handler = messageHandler()
    if (!handler) return false
    try {
      this.sequence += 1
      handler.postMessage({
        protocol: NATIVE_WEBVIEW_PROTOCOL,
        version: NATIVE_WEBVIEW_VERSION,
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

  private postForAttachment(
    type: string,
    attachmentId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const record = this.attachments.get(attachmentId)
    if (!record) return false
    return this.post(type, { webPaneId: record.webPaneId, attachmentId, ...payload })
  }

  private inspectAtPoint(
    attachmentId: string,
    x: number,
    y: number,
    grade: TileInspectGrade,
  ): Promise<TileInspectResult> {
    if (!this.capabilities.has(NATIVE_WEBVIEW_INSPECT_CAPABILITY)) {
      return Promise.reject(new Error('Native web view inspection is not supported'))
    }
    if (
      !Number.isFinite(x) || x < 0 || x > MAX_INSPECTION_COORDINATE ||
      !Number.isFinite(y) || y < 0 || y > MAX_INSPECTION_COORDINATE ||
      (grade !== 'hover' && grade !== 'click')
    ) {
      return Promise.reject(new Error('Invalid native web view inspection request'))
    }
    if (!this.attachments.has(attachmentId)) {
      return Promise.reject(new Error('Native web view attachment is not active'))
    }
    if (this.pendingInspects.size + this.pendingResolves.size >= MAX_PENDING_INSPECTIONS) {
      return Promise.reject(new Error('Too many pending native web view inspections'))
    }
    const requestId = this.nextRequestId()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingInspects.delete(requestId)
        reject(new Error('Native web view inspection timed out'))
      }, INSPECTION_TIMEOUT_MS)
      this.pendingInspects.set(requestId, { attachmentId, resolve, reject, timer })
      if (!this.postForAttachment('webview.inspectAtPoint', attachmentId, { requestId, x, y, grade })) {
        window.clearTimeout(timer)
        this.pendingInspects.delete(requestId)
        reject(new Error('Native web view handler became unavailable'))
      }
    })
  }

  private resolveSelectors(
    attachmentId: string,
    value: readonly TileSelectorResolveItem[],
  ): Promise<TileSelectorAnchor[]> {
    if (!this.capabilities.has(NATIVE_WEBVIEW_RESOLVE_SELECTORS_CAPABILITY)) {
      return Promise.reject(new Error('Native web view selector resolution is not supported'))
    }
    if (!this.attachments.has(attachmentId)) {
      return Promise.reject(new Error('Native web view attachment is not active'))
    }
    if (!Array.isArray(value) || value.length > MAX_SELECTOR_RESOLVE_ITEMS) {
      return Promise.reject(new Error('Invalid native web view selector request'))
    }
    if (value.length === 0) return Promise.resolve([])
    const items: TileSelectorResolveItem[] = []
    const noteIds = new Set<number>()
    for (const item of value) {
      if (
        typeof item !== 'object' || item === null ||
        !Number.isSafeInteger(item.noteId) || item.noteId < 1 || noteIds.has(item.noteId) ||
        typeof item.selector !== 'string' || item.selector.length < 1 ||
        item.selector.length > MAX_INSPECT_SELECTOR
      ) {
        return Promise.reject(new Error('Invalid native web view selector request'))
      }
      noteIds.add(item.noteId)
      items.push({ noteId: item.noteId, selector: item.selector })
    }
    if (new TextEncoder().encode(JSON.stringify(items)).byteLength > MAX_SELECTOR_RESOLVE_BYTES) {
      return Promise.reject(new Error('Native web view selector request is too large'))
    }
    if (this.pendingInspects.size + this.pendingResolves.size >= MAX_PENDING_INSPECTIONS) {
      return Promise.reject(new Error('Too many pending native web view inspections'))
    }
    const requestId = this.nextRequestId()
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingResolves.delete(requestId)
        reject(new Error('Native web view selector resolution timed out'))
      }, INSPECTION_TIMEOUT_MS)
      this.pendingResolves.set(requestId, {
        attachmentId,
        requestedNoteIds: noteIds,
        resolve,
        reject,
        timer,
      })
      if (!this.postForAttachment('webview.resolveSelectors', attachmentId, { requestId, items })) {
        window.clearTimeout(timer)
        this.pendingResolves.delete(requestId)
        reject(new Error('Native web view handler became unavailable'))
      }
    })
  }

  private nextRequestId(): string {
    this.requestSequence += 1
    return `r${this.requestSequence}`
  }

  private rejectPendingForAttachment(attachmentId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingInspects) {
      if (pending.attachmentId !== attachmentId) continue
      window.clearTimeout(pending.timer)
      this.pendingInspects.delete(requestId)
      pending.reject(new Error(reason))
    }
    for (const [requestId, pending] of this.pendingResolves) {
      if (pending.attachmentId !== attachmentId) continue
      window.clearTimeout(pending.timer)
      this.pendingResolves.delete(requestId)
      pending.reject(new Error(reason))
    }
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pendingInspects.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    for (const pending of this.pendingResolves.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingInspects.clear()
    this.pendingResolves.clear()
  }

  private completeNegotiation(result: NativeWebViewNegotiation): void {
    if (!this.finishNegotiation) return
    if (this.handshakeTimer !== undefined) window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    const finish = this.finishNegotiation
    this.finishNegotiation = undefined
    this.connected = result.available
    this.maxWebViews = result.available ? result.maxWebViews : 0
    this.capabilities = new Set(result.available ? result.capabilities : [])
    finish(result)
  }

  private receive(value: unknown): void {
    if (!isObject(value) || value.pageId !== this.pageId) return
    if (typeof value.version === 'number' && value.version !== NATIVE_WEBVIEW_VERSION) {
      this.completeNegotiation({ available: false, reason: 'version-mismatch' })
      return
    }
    const eventSequence = value.eventSequence
    const type = value.type
    const payload = value.payload
    if (
      typeof eventSequence !== 'number' ||
      !Number.isSafeInteger(eventSequence) ||
      eventSequence <= this.lastEventSequence ||
      typeof type !== 'string' ||
      !isObject(payload)
    ) return
    this.lastEventSequence = eventSequence

    if (type === 'bridge.connected') {
      const capabilities = Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((entry): entry is string => typeof entry === 'string')
        : []
      const maxWebViews = typeof payload.maxWebViews === 'number' ? payload.maxWebViews : 0
      const missing = REQUIRED_NATIVE_WEBVIEW_CAPABILITIES.filter(
        (capability) => !capabilities.includes(capability),
      )
      this.completeNegotiation(missing.length > 0 || maxWebViews < 1
        ? { available: false, reason: 'missing-capabilities' }
        : { available: true, capabilities, maxWebViews })
      return
    }
    if (type === 'bridge.rejected') {
      if (!this.connected) {
        const reason = typeof payload.reason === 'string' ? payload.reason : 'rejected'
        this.completeNegotiation({ available: false, reason })
      }
      return
    }
    if (!this.connected) return

    const attachmentId = payload.attachmentId
    if (typeof attachmentId !== 'string') return
    const record = this.attachments.get(attachmentId)
    if (!record || payload.webPaneId !== record.webPaneId) return

    if (type === 'webview.inspectAtPoint.result') {
      const requestId = payload.requestId
      if (typeof requestId !== 'string') return
      const pending = this.pendingInspects.get(requestId)
      if (!pending || pending.attachmentId !== attachmentId) return
      const result = parseTileInspectResult(payload.result)
      window.clearTimeout(pending.timer)
      this.pendingInspects.delete(requestId)
      if (result) pending.resolve(result)
      else pending.reject(new Error('Native web view returned an invalid inspection result'))
      return
    }
    if (type === 'webview.resolveSelectors.result') {
      const requestId = payload.requestId
      if (typeof requestId !== 'string') return
      const pending = this.pendingResolves.get(requestId)
      if (!pending || pending.attachmentId !== attachmentId) return
      window.clearTimeout(pending.timer)
      this.pendingResolves.delete(requestId)
      if (payload.ok !== true) {
        pending.reject(new Error(
          typeof payload.error === 'string'
            ? payload.error.slice(0, 256)
            : 'Selector resolution failed',
        ))
        return
      }
      const anchors = parseTileSelectorAnchors(payload.anchors)
      if (!anchors || anchors.some((anchor) => !pending.requestedNoteIds.has(anchor.noteId))) {
        pending.reject(new Error('Native web view returned invalid selector anchors'))
        return
      }
      pending.resolve(anchors)
      return
    }

    if (type === 'webview.attached') {
      record.listener({ type: 'webview.attached' })
    } else if (type === 'webview.loaded') {
      record.listener({ type: 'webview.loaded' })
    } else if (type === 'webview.failed') {
      record.listener({
        type: 'webview.failed',
        code: typeof payload.code === 'string' ? payload.code : 'unknown',
      })
    } else if (type === 'webview.detached') {
      this.rejectPendingForAttachment(attachmentId, 'Native web view attachment detached')
      this.attachments.delete(attachmentId)
    }
  }
}

let sharedBridge: NativeWebViewBridge | undefined

export function getNativeWebViewBridge(): NativeWebViewBridge | null {
  if (!hasNativeWebViewHandler()) return null
  sharedBridge ??= new NativeWebViewBridge()
  return sharedBridge
}

export function resetNativeWebViewBridge(): void {
  sharedBridge?.dispose()
  sharedBridge = undefined
}
