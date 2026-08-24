// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WebPane } from '../shared/protocol'
import { resetNativeWebViewBridge } from './nativeWebViewBridge'
import { CHROMIUM_RENDERER_STORAGE_KEY, WebPaneCard } from './WebPaneCard'

vi.mock('./ChromiumTileCard', () => ({
  ChromiumTileCard: () => <div data-testid="chromium-tile" />,
}))

vi.mock('./NativeWebViewTile', () => ({
  NativeWebViewTile: ({ onLoaded, onFallback }: { onLoaded?: () => void; onFallback: () => void }) => (
    <div data-testid="native-webview-tile">
      <button type="button" onClick={onLoaded}>mark native loaded</button>
      <button type="button" onClick={onFallback}>fail native renderer</button>
    </div>
  ),
}))

type PostedMessage = Record<string, unknown>

function installNativeHandler(messages: PostedMessage[]) {
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        commandoNativeWebView: {
          postMessage: (message: PostedMessage) => messages.push(message),
        },
      },
    },
  })
}

async function makeNativeBridgeAvailable(messages: PostedMessage[]) {
  await waitFor(() => expect(messages).toHaveLength(1))
  const connect = messages[0]
  act(() => {
    window.__commandoNativeWebViewReceive?.({
      version: 1,
      pageId: connect.pageId,
      eventSequence: 1,
      type: 'bridge.connected',
      payload: { capabilities: ['webview.embed.v1'], maxWebViews: 4 },
    })
  })
  await screen.findByRole('button', { name: 'Use native web view renderer' })
}

beforeEach(() => {
  resetNativeWebViewBridge()
  window.localStorage.clear()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
})

afterEach(() => {
  cleanup()
  resetNativeWebViewBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
})

const webPane: WebPane = {
  id: 'w-0badcafe',
  url: 'http://localhost:5173/plan',
  sessionId: '$1',
  windowId: '@3',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'webkit',
  openedBy: 'user',
  status: 'open',
  createdAt: Date.now(),
}

describe('WebPaneCard dragging', () => {
  it('makes the header draggable and forwards drag start/end', () => {
    const onDragStart = vi.fn()
    const onDragEnd = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />,
    )

    const header = screen.getByTitle('Drag onto a terminal pane to move this tile')
    expect(header).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(header)
    expect(onDragStart).toHaveBeenCalledTimes(1)
    fireEvent.dragEnd(header)
    expect(onDragEnd).toHaveBeenCalledTimes(1)
  })

  it('is not draggable without a drag handler', () => {
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
      />,
    )
    expect(document.querySelector('.web-pane-head')).toHaveAttribute('draggable', 'false')
  })
})

describe('WebPaneCard url editing', () => {
  it('opens an inline editor and commits a new url on Enter', () => {
    const onNavigate = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change URL' }))
    const input = screen.getByRole('textbox', { name: 'Web pane URL' })
    expect(input).toHaveValue('http://localhost:5173/plan')
    fireEvent.change(input, { target: { value: 'http://localhost:4310/report' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onNavigate).toHaveBeenCalledWith('http://localhost:4310/report')
  })

  it('cancels the editor on Escape without navigating', () => {
    const onNavigate = vi.fn()
    render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Change URL' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Web pane URL' }), { key: 'Escape' })
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Web pane URL' })).toBeNull()
  })
})

describe('WebPaneCard maximize', () => {
  it('renders a maximize toggle that reflects and flips the state', () => {
    const onMaximize = vi.fn()
    const { rerender } = render(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        maximized={false}
        onMaximize={onMaximize}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    expect(onMaximize).toHaveBeenCalledTimes(1)

    rerender(
      <WebPaneCard
        webPane={webPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        wsToken=""
        maximized
        onMaximize={onMaximize}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore web pane' })).toBeInTheDocument()
  })
})

describe('WebPaneCard AppKit popout', () => {
  const chromiumPane: WebPane = { ...webPane, engine: 'chromium' }

  it('groups chromium metadata separately from the complete action set', () => {
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        onOpenDevtools={() => undefined}
        onPopOut={() => undefined}
        onMaximize={() => undefined}
      />,
    )

    const metadata = document.querySelector('.web-pane-meta')
    const actions = document.querySelector('.web-pane-actions')
    expect(metadata).toHaveTextContent('web')
    expect(metadata).toHaveTextContent('chromium')
    expect(actions?.querySelectorAll('button')).toHaveLength(7)
    expect(screen.getByRole('button', { name: 'Review this page' })).toHaveClass('web-pane-button')
    expect(screen.getByRole('button', { name: 'Close web pane' })).toHaveClass('web-pane-button')
  })

  it('offers popout for an attached chromium pane', () => {
    const onPopOut = vi.fn()
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        onPopOut={onPopOut}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pop out web pane' }))
    expect(onPopOut).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('chromium-tile')).toBeInTheDocument()
  })

  it('unmounts the stream and offers focus or reattach while detached', () => {
    const onFocusDetached = vi.fn()
    const onReattach = vi.fn()
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        detached
        onFocusDetached={onFocusDetached}
        onReattach={onReattach}
      />,
    )

    expect(screen.queryByTestId('chromium-tile')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pop out web pane' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }))
    expect(onFocusDetached).toHaveBeenCalledTimes(1)
    expect(onReattach).toHaveBeenCalledTimes(1)
  })

  it('offers a return control inside the detached window', () => {
    const onReattach = vi.fn()
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
        detachedWindow
        onReattach={onReattach}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Return web pane to workspace' }))
    expect(onReattach).toHaveBeenCalledTimes(1)
  })
})

describe('WebPaneCard Chromium renderer experiment', () => {
  const chromiumPane: WebPane = { ...webPane, engine: 'chromium' }

  it('switches between the canvas stream and native WKWebView locally', async () => {
    const messages: PostedMessage[] = []
    installNativeHandler(messages)
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    await makeNativeBridgeAvailable(messages)

    expect(screen.getByTestId('chromium-tile')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use native web view renderer' }))
    expect(screen.getByTestId('native-webview-tile')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review this page' })).not.toBeInTheDocument()
    expect(window.localStorage.getItem(CHROMIUM_RENDERER_STORAGE_KEY)).toBe('native')
    expect(screen.getByText('loading')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'mark native loaded' }))
    expect(screen.getByText('native')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use canvas stream renderer' }))
    expect(screen.getByTestId('chromium-tile')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review this page' })).toBeInTheDocument()
    expect(window.localStorage.getItem(CHROMIUM_RENDERER_STORAGE_KEY)).toBe('canvas')
  })

  it('falls back to the canvas when the native renderer fails', async () => {
    const messages: PostedMessage[] = []
    installNativeHandler(messages)
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    await makeNativeBridgeAvailable(messages)

    fireEvent.click(screen.getByRole('button', { name: 'Use native web view renderer' }))
    fireEvent.click(screen.getByRole('button', { name: 'fail native renderer' }))
    expect(screen.getByTestId('chromium-tile')).toBeInTheDocument()
    expect(window.localStorage.getItem(CHROMIUM_RENDERER_STORAGE_KEY)).toBe('canvas')
  })

  it('falls back when the native renderer never finishes loading', async () => {
    const messages: PostedMessage[] = []
    installNativeHandler(messages)
    render(
      <WebPaneCard
        webPane={chromiumPane}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    await makeNativeBridgeAvailable(messages)

    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Use native web view renderer' }))
      act(() => vi.advanceTimersByTime(8_000))
      expect(screen.getByTestId('chromium-tile')).toBeInTheDocument()
      expect(window.localStorage.getItem(CHROMIUM_RENDERER_STORAGE_KEY)).toBe('canvas')
    } finally {
      vi.useRealTimers()
    }
  })
})
