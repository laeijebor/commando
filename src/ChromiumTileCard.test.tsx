// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane } from '../shared/protocol'
import { ChromiumTileCard } from './ChromiumTileCard'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readonly url: string
  readyState = 0
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

function renderTile() {
  return render(
    <ChromiumTileCard
      webPane={webPane}
      wsToken="t"
      reloadKey={0}
      reviewMode={false}
      onSubmitFeedback={async () => undefined}
    />,
  )
}

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
