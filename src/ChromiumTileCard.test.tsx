// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane, WebPanePendingSnapshot } from '../shared/protocol'
import { ChromiumTileCard, type PendingQueueApi } from './ChromiumTileCard'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readonly url: string
  readyState = 0
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    let handlers = this.listeners.get(type)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(type, handlers)
    }
    handlers.add(handler)
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler)
  }

  send(): void {}

  close(): void {
    this.closeCount += 1
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code: 1005 })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', {})
  }

  message(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }

  private dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }
}

const webPane: WebPane = {
  id: 'w-abcd1234',
  url: 'http://127.0.0.1:41300/plan',
  sessionId: '$3',
  windowId: '@2',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'chromium',
  openedBy: 'agent',
  openerLabel: 'claude · gizmo',
  status: 'open',
  createdAt: Date.now(),
}

const EMPTY_SNAPSHOT: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }

function renderTile(
  pendingQueue: Partial<PendingQueueApi> = {},
  keepStreamingWhenHidden = false,
) {
  return render(
    <ChromiumTileCard
      webPane={webPane}
      wsToken="t"
      reloadKey={0}
      reviewMode={false}
      pendingQueue={{
        list: async () => EMPTY_SNAPSHOT,
        add: async () => EMPTY_SNAPSHOT,
        remove: async () => EMPTY_SNAPSHOT,
        send: async () => EMPTY_SNAPSHOT,
        dismissDropped: async () => EMPTY_SNAPSHOT,
        ...pendingQueue,
      }}
      keepStreamingWhenHidden={keepStreamingWhenHidden}
    />,
  )
}

describe('ChromiumTileCard pending hydration', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    window.localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  const mirrored = [{
    id: 7,
    selector: '#root > button',
    tag: 'button',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    comment: 'from the mirror',
  }]

  it('does not restore mirrored notes the daemon has already accounted for', async () => {
    window.localStorage.setItem(`commando.redline.pending.${webPane.id}`, JSON.stringify(mirrored))
    const add = vi.fn(async () => EMPTY_SNAPSHOT)
    // knownUpTo 7 means id 7 was issued and has since been sent or removed.
    renderTile({ list: async () => ({ notes: [], knownUpTo: 7, dropped: 0 }), add })
    await act(async () => { await Promise.resolve() })
    expect(add).not.toHaveBeenCalled()
  })

  it('restores mirrored notes the daemon has no record of ever issuing', async () => {
    window.localStorage.setItem(`commando.redline.pending.${webPane.id}`, JSON.stringify(mirrored))
    const add: PendingQueueApi['add'] = vi.fn(async () => ({ notes: mirrored, knownUpTo: 1, dropped: 0 }))
    // A watermark below the mirrored id means the journal was lost.
    renderTile({ list: async () => ({ notes: [], knownUpTo: 0, dropped: 0 }), add })
    await act(async () => { await Promise.resolve() })
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ comment: 'from the mirror' }))
    expect(await screen.findByText('from the mirror')).toBeInTheDocument()
  })

  it('shows a capped-answer warning pushed by the daemon', async () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    await act(async () => {
      socket.open()
      socket.message({ type: 'pending', notes: [], knownUpTo: 51, dropped: 2 })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/2 older answers dropped/i)
  })
})

describe('ChromiumTileCard first-frame watchdog', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('turns a frameless stream into a retryable error instead of spinning forever', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      socket.message({ type: 'ready' })
    })
    expect(screen.getByText('Starting chromium stream…')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(screen.getByText(/no frames/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('does not fire the watchdog once a frame has arrived', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.open()
      socket.message({ type: 'ready' })
      // jsdom never fires Image.onload, so the canvas stays pending — but a
      // received frame must still disarm the watchdog.
      socket.message({ type: 'frame', data: 'QUJD' })
    })
    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.queryByText(/no frames/i)).not.toBeInTheDocument()
  })
})

describe('ChromiumTileCard detached visibility', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('keeps a detached AppKit stream open when its document becomes hidden', () => {
    renderTile({}, true)
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(socket.closeCount).toBe(0)
  })

  it('still closes an ordinary workspace stream when hidden', () => {
    renderTile()
    const socket = FakeWebSocket.instances[0]
    act(() => socket.open())

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(socket.closeCount).toBe(1)
  })
})
