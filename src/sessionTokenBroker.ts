export const SESSION_TOKEN_CHANNEL_NAME = 'commando.session-token.v1'
export const MAX_SESSION_TOKEN_BYTES = 8 * 1_024
export const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 750

type ChannelMessageEvent = { data: unknown }
type ChannelMessageListener = (event: ChannelMessageEvent) => void

export type SessionTokenChannel = {
  postMessage: (message: unknown) => void
  addEventListener: (type: 'message', listener: ChannelMessageListener) => void
  removeEventListener: (type: 'message', listener: ChannelMessageListener) => void
  close: () => void
}

export type SessionTokenChannelFactory = (name: string) => SessionTokenChannel

type PendingRequest = {
  timer: number
  resolve: (token: string) => void
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value)
}

export function isBoundedSessionToken(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    new TextEncoder().encode(value).byteLength <= MAX_SESSION_TOKEN_BYTES
}

function defaultIdentifier(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function defaultChannelFactory(name: string): SessionTokenChannel {
  return new BroadcastChannel(name) as SessionTokenChannel
}

export class SessionTokenBroker {
  private readonly peerId: string
  private readonly channel: SessionTokenChannel | null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly clearListeners = new Set<() => void>()
  private readonly tokenListeners = new Set<(token: string) => void>()
  private readonly receiveMessage = (event: ChannelMessageEvent) => this.receive(event.data)
  private availabilityRequest: Promise<string> | null = null
  private heldToken = ''
  private closed = false

  constructor(
    channelFactory: SessionTokenChannelFactory = defaultChannelFactory,
    private readonly identifierFactory: () => string = defaultIdentifier,
  ) {
    this.peerId = identifierFactory()
    try {
      this.channel = typeof BroadcastChannel === 'undefined' && channelFactory === defaultChannelFactory
        ? null
        : channelFactory(SESSION_TOKEN_CHANNEL_NAME)
      this.channel?.addEventListener('message', this.receiveMessage)
    } catch {
      this.channel = null
    }
  }

  get hasToken(): boolean {
    return this.heldToken.length > 0
  }

  setToken(token: string): boolean {
    if (this.closed || !isBoundedSessionToken(token)) return false
    if (this.heldToken === token) return true
    this.availabilityRequest = null
    this.resolvePending('')
    this.heldToken = token
    if (isIdentifier(this.peerId)) {
      this.post({
        version: 1,
        type: 'available',
        senderId: this.peerId,
      })
    }
    return true
  }

  forgetToken(): void {
    this.heldToken = ''
  }

  requestToken(timeoutMs = DEFAULT_TOKEN_REQUEST_TIMEOUT_MS): Promise<string> {
    if (this.closed || !this.channel) return Promise.resolve('')
    if (this.heldToken) return Promise.resolve(this.heldToken)
    const requestId = this.identifierFactory()
    if (!isIdentifier(this.peerId) || !isIdentifier(requestId)) return Promise.resolve('')

    return new Promise((resolve) => {
      const finish = (token: string) => {
        const pending = this.pending.get(requestId)
        if (!pending) return
        window.clearTimeout(pending.timer)
        this.pending.delete(requestId)
        resolve(token)
      }
      const timer = window.setTimeout(() => finish(''), Math.max(1, Math.min(timeoutMs, 5_000)))
      this.pending.set(requestId, { timer, resolve })
      if (!this.post({
        version: 1,
        type: 'request',
        senderId: this.peerId,
        requestId,
      })) {
        finish('')
      }
    })
  }

  clear(): void {
    if (this.closed) return
    this.heldToken = ''
    this.availabilityRequest = null
    this.resolvePending('')
    this.post({
      version: 1,
      type: 'clear',
      senderId: this.peerId,
    })
  }

  onClear(listener: () => void): () => void {
    if (this.closed) return () => undefined
    this.clearListeners.add(listener)
    return () => this.clearListeners.delete(listener)
  }

  onToken(listener: (token: string) => void): () => void {
    if (this.closed) return () => undefined
    this.tokenListeners.add(listener)
    return () => this.tokenListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.heldToken = ''
    this.availabilityRequest = null
    this.resolvePending('')
    this.clearListeners.clear()
    this.tokenListeners.clear()
    this.channel?.removeEventListener('message', this.receiveMessage)
    this.channel?.close()
  }

  private receive(value: unknown): void {
    if (this.closed || !this.channel || !isObject(value) || value.version !== 1) return
    if (!isIdentifier(value.senderId) || value.senderId === this.peerId) return

    if (value.type === 'available' && exactKeys(value, ['version', 'type', 'senderId'])) {
      this.retryForAvailability()
      return
    }

    if (
      value.type === 'request' &&
      exactKeys(value, ['version', 'type', 'senderId', 'requestId']) &&
      isIdentifier(value.requestId)
    ) {
      if (!this.heldToken) return
      this.post({
        version: 1,
        type: 'response',
        senderId: this.peerId,
        targetId: value.senderId,
        requestId: value.requestId,
        token: this.heldToken,
      })
      return
    }

    if (
      value.type === 'response' &&
      exactKeys(value, ['version', 'type', 'senderId', 'targetId', 'requestId', 'token']) &&
      value.targetId === this.peerId &&
      isIdentifier(value.requestId) &&
      isBoundedSessionToken(value.token)
    ) {
      const pending = this.pending.get(value.requestId)
      if (!pending) return
      window.clearTimeout(pending.timer)
      this.pending.delete(value.requestId)
      this.heldToken = value.token
      pending.resolve(value.token)
      return
    }

    if (value.type === 'clear' && exactKeys(value, ['version', 'type', 'senderId'])) {
      this.heldToken = ''
      this.availabilityRequest = null
      this.resolvePending('')
      for (const listener of this.clearListeners) listener()
    }
  }

  private retryForAvailability(): void {
    if (this.closed || this.heldToken || this.availabilityRequest) return
    const request = this.requestToken()
    this.availabilityRequest = request
    void request.then((token) => {
      if (this.availabilityRequest !== request) return
      this.availabilityRequest = null
      if (this.closed || !token) return
      for (const listener of this.tokenListeners) listener(token)
    })
  }

  private resolvePending(token: string): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.resolve(token)
    }
    this.pending.clear()
  }

  private post(message: unknown): boolean {
    try {
      this.channel?.postMessage(message)
      return this.channel !== null
    } catch {
      return false
    }
  }
}
