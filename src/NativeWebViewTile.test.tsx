// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebPane, WebPanePendingSnapshot } from '../shared/protocol'
import type {
  NativeWebViewAttachment,
  NativeWebViewBridge,
  NativeWebViewTileEvent,
} from './nativeWebViewBridge'
import { NativeWebViewTile } from './NativeWebViewTile'
import type { PendingQueueApi } from './pendingQueueApi'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  closeCount = 0
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closeCount += 1
  }

  message(value: unknown): void {
    const event = { data: JSON.stringify(value) } as MessageEvent
    for (const listener of this.listeners.get('message') ?? []) listener(event)
  }
}

const webPane: WebPane = {
  id: 'w-abcd1234',
  url: 'http://localhost:5173/review',
  sessionId: '$1',
  windowId: '@2',
  anchorPaneId: '%3',
  placement: 'right',
  engine: 'chromium',
  openedBy: 'user',
  status: 'open',
  createdAt: 0,
}

const emptySnapshot: WebPanePendingSnapshot = { notes: [], knownUpTo: 0, dropped: 0 }
const pendingQueue: PendingQueueApi = {
  list: async () => emptySnapshot,
  add: async () => emptySnapshot,
  update: async () => emptySnapshot,
  upload: async () => emptySnapshot,
  removeAttachment: async () => emptySnapshot,
  attachmentUrl: () => '',
  remove: async () => emptySnapshot,
  send: async () => emptySnapshot,
  dismissDropped: async () => emptySnapshot,
}

function nativeHarness(supportsReview = true) {
  let listener: ((event: NativeWebViewTileEvent) => void) | undefined
  const attachment: NativeWebViewAttachment = {
    attachmentId: 'page:1',
    supportsReview,
    inspectAtPoint: vi.fn(async () => ({
      ok: true as const,
      selector: '#target',
      tag: 'button',
      rect: { x: 10, y: 12, width: 80, height: 24 },
    })),
    resolveSelectors: vi.fn(async () => [{
      noteId: 1,
      rect: { x: 10, y: 12, width: 80, height: 24 },
    }]),
    setReviewInput: vi.fn(() => supportsReview),
    presentReviewHighlights: vi.fn(() => supportsReview),
    detach: vi.fn(),
  }
  const bridge = {
    attach: vi.fn((_id: string, _url: string, next: (event: NativeWebViewTileEvent) => void) => {
      listener = next
      return attachment
    }),
    frame: vi.fn(() => true),
    reload: vi.fn(() => true),
  } as unknown as NativeWebViewBridge
  return { attachment, bridge, loaded: () => listener?.({ type: 'webview.loaded' }) }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NativeWebViewTile review integration', () => {
  it('keeps the native attachment active, routes review input, highlights, and pending snapshots', async () => {
    const { attachment, bridge } = nativeHarness()
    const view = render(
      <NativeWebViewTile
        bridge={bridge}
        webPane={webPane}
        reloadKey={0}
        reviewMode
        wsToken="owner token"
        pendingQueue={pendingQueue}
        onFallback={() => undefined}
      />,
    )

    await waitFor(() => expect(attachment.setReviewInput).toHaveBeenCalledWith(true))
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toContain('/ws/web-tiles/w-abcd1234?mode=review')
    expect(FakeWebSocket.instances[0].url).toContain('token=owner+token')

    act(() => FakeWebSocket.instances[0].message({
      type: 'pending',
      revision: 1,
      notes: [{
        id: 1,
        revision: 1,
        selector: '#target',
        tag: 'button',
        rect: { x: 10, y: 12, width: 80, height: 24 },
        comment: 'Tighten this copy',
        attachments: [],
      }],
      knownUpTo: 1,
      dropped: 0,
    }))
    expect(await screen.findByRole('button', { name: 'Review queue · 1' })).toBeInTheDocument()

    fireEvent.pointerMove(document.querySelector('.web-pane-native-review-input')!, {
      clientX: 20,
      clientY: 24,
    })
    await waitFor(() => expect(attachment.presentReviewHighlights).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'hover', rect: { x: 10, y: 12, width: 80, height: 24 } }),
        expect.objectContaining({ kind: 'annotation' }),
      ]),
    ))

    expect(attachment.detach).not.toHaveBeenCalled()
    view.unmount()
    expect(attachment.setReviewInput).toHaveBeenLastCalledWith(false)
    expect(attachment.presentReviewHighlights).toHaveBeenLastCalledWith([])
    expect(attachment.detach).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances[0].closeCount).toBe(1)
  })

  it('requests Canvas fallback when native review capabilities are absent', async () => {
    const { bridge } = nativeHarness(false)
    const onReviewFallback = vi.fn()
    render(
      <NativeWebViewTile
        bridge={bridge}
        webPane={webPane}
        reloadKey={0}
        reviewMode
        pendingQueue={pendingQueue}
        onReviewFallback={onReviewFallback}
        onFallback={() => undefined}
      />,
    )

    await waitFor(() => expect(onReviewFallback).toHaveBeenCalledOnce())
  })
})
