import type { NativeTerminalFramePayload } from './nativeTerminalBridge'
import { isNativeTerminalFramePayload } from './nativeTerminalBridge'

/**
 * Bridge to the desktop shell's native web-view tier. WebKit panes use it for
 * external origins that refuse framing; Chromium panes can also use it as an
 * experimental, client-local visible surface. A small sibling of the native
 * terminal bridge with the same envelope shape.
 */
export const NATIVE_WEBVIEW_PROTOCOL = 'commando.native-webview' as const
export const NATIVE_WEBVIEW_VERSION = 1 as const
export const REQUIRED_NATIVE_WEBVIEW_CAPABILITIES = ['webview.embed.v1'] as const

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
  detach: () => void
}

type AttachmentRecord = {
  webPaneId: string
  attachmentId: string
  listener: (event: NativeWebViewTileEvent) => void
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000

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
  private readonly attachments = new Map<string, AttachmentRecord>()
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
      detach: () => {
        if (this.attachments.delete(attachmentId)) {
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

  private completeNegotiation(result: NativeWebViewNegotiation): void {
    if (!this.finishNegotiation) return
    if (this.handshakeTimer !== undefined) window.clearTimeout(this.handshakeTimer)
    this.handshakeTimer = undefined
    const finish = this.finishNegotiation
    this.finishNegotiation = undefined
    this.connected = result.available
    this.maxWebViews = result.available ? result.maxWebViews : 0
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
