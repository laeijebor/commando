// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ServerMessage, WebPane } from '../shared/protocol'
import { DetachedWebPaneApp } from './DetachedWebPaneApp'
import { resetNativeWindowBridge } from './nativeWindowBridge'

const daemon = vi.hoisted(() => ({
  onMessage: null as ((message: ServerMessage) => void) | null,
}))
const chromiumProps = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('./authClient', () => ({
  getAuthBootstrap: async () => ({ enabled: false, needsOwner: false, ownerEmail: null }),
  getAuthUser: async () => null,
}))

vi.mock('./useDaemon', () => ({
  useDaemon: (
    _token: string,
    _sessionAuthenticated: boolean,
    onMessage: (message: ServerMessage) => void,
  ) => {
    daemon.onMessage = onMessage
    return {
      connection: { phase: 'live', detail: 'Authenticated local stream', attempt: 0 },
      send: vi.fn(),
    }
  },
}))

vi.mock('./ChromiumTileCard', () => ({
  ChromiumTileCard: (props: Record<string, unknown>) => {
    chromiumProps.push(props)
    return <div data-testid="detached-chromium-stream" />
  },
}))

const webPane: WebPane = {
  id: 'w-abcd1234',
  url: 'http://127.0.0.1:4310/redline/artifacts/1234567890abcdef/page.html',
  sessionId: '$1',
  windowId: '@1',
  anchorPaneId: '%1',
  placement: 'right',
  engine: 'chromium',
  openedBy: 'user',
  status: 'open',
  createdAt: Date.now(),
}

function installHandler(messages: Array<Record<string, unknown>>) {
  Object.defineProperty(window, 'webkit', {
    configurable: true,
    value: {
      messageHandlers: {
        commandoNativeWindow: {
          postMessage: (message: Record<string, unknown>) => messages.push(message),
        },
      },
    },
  })
}

beforeEach(() => {
  daemon.onMessage = null
  chromiumProps.length = 0
  resetNativeWindowBridge()
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  resetNativeWindowBridge()
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined })
})

describe('DetachedWebPaneApp', () => {
  it('renders only the selected pane and keeps its stream alive while inactive', async () => {
    installHandler([])
    render(<DetachedWebPaneApp webPaneId={webPane.id} />)

    act(() => daemon.onMessage?.({ type: 'web_panes', webPanes: [webPane] }))

    expect(await screen.findByTestId('detached-chromium-stream')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Return web pane to workspace' })).toBeInTheDocument()
    expect(chromiumProps.at(-1)).toMatchObject({ keepStreamingWhenHidden: true })
    expect(document.querySelector('.cockpit')).not.toBeInTheDocument()
  })

  it('asks AppKit to close the focused window when the pane no longer exists', async () => {
    const messages: Array<Record<string, unknown>> = []
    installHandler(messages)
    render(<DetachedWebPaneApp webPaneId={webPane.id} />)

    act(() => daemon.onMessage?.({ type: 'web_panes', webPanes: [] }))

    await waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: 'web-pane.reattach',
      payload: { webPaneId: webPane.id },
    })))
  })
})
