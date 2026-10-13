// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, LayoutSpec, ServerMessage, SessionBrief, TmuxPane } from '../shared/protocol'
import { App, AuthGate, PANE_JUMP_HIGHLIGHT_MS, PR_PANE_LOOKUP_TIMEOUT_MS, PaneActionErrorFeedback, TerminalPaneCard } from './App'
import { createPrsApi } from './prsApi'
import { refreshPanePrs } from './prStore'
import { getAuthBootstrap, getAuthUser } from './authClient'
import type { ConnectionState } from './useDaemon'
import { NARROW_PANEL_QUERY } from './sidePanelState'
import * as nativeWebViewBridge from './nativeWebViewBridge'
import { DESKTOP_WINDOW_ACTIVITY_EVENT } from './desktopWindowActivity'

const appMocks = vi.hoisted(() => ({
  nativeConnect: vi.fn(),
  send: vi.fn(),
  useDaemon: vi.fn(),
}))

vi.mock('./authClient', () => ({
  createOwner: vi.fn(),
  getAuthBootstrap: vi.fn(),
  getAuthUser: vi.fn(),
  signInWithEmail: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('./useDaemon', () => ({
  useDaemon: appMocks.useDaemon,
}))
vi.mock('./nativeTerminalBridge', () => ({
  NATIVE_TERMINAL_SHORTCUT_EVENT: 'commando:native-terminal-shortcut',
  getNativeTerminalBridge: () => ({ connect: appMocks.nativeConnect, setTheme: () => true }),
}))
vi.mock('./TerminalPaneRenderer', () => ({
  TerminalPaneRenderer: ({
    paneId,
    nativeRetryKey = 0,
    useXtermFallback,
    onRendererChange,
    onSelectionCopied,
    registerFocusable,
    resizeOwner,
    measurementKey,
    onFocus,
    onResize,
  }: {
    paneId: string
    nativeRetryKey?: number
    useXtermFallback?: boolean
    onRendererChange: (renderer: 'native' | 'xterm') => void
    onSelectionCopied: () => void
    registerFocusable: (paneId: string, node: HTMLElement | null) => void
    resizeOwner: boolean
    measurementKey: string
    onFocus: () => void
    onResize: (cols: number, rows: number) => void
  }) => {
    const [failed, setFailed] = useState(false)
    const previousRetryKey = useRef(nativeRetryKey)
    const renderer = useXtermFallback || failed ? 'xterm' : 'native'

    useEffect(() => {
      if (previousRetryKey.current === nativeRetryKey) return
      previousRetryKey.current = nativeRetryKey
      setFailed(false)
    }, [nativeRetryKey])

    useEffect(() => onRendererChange(renderer), [onRendererChange, renderer])

    return (
      <div
        ref={(node) => registerFocusable(paneId, node)}
        tabIndex={-1}
        data-testid={`renderer-${paneId}`}
        data-renderer={renderer}
        data-native-retry-key={nativeRetryKey}
        data-xterm-fallback={String(Boolean(useXtermFallback))}
        data-resize-owner={String(resizeOwner)}
        data-measurement-key={measurementKey}
        onFocus={onFocus}
      >
        <button type="button" onClick={onSelectionCopied}>Simulate terminal selection copy</button>
        <button type="button" onClick={() => setFailed(true)}>Simulate native failure {paneId}</button>
        <button type="button" onClick={() => onResize(150, 40)}>Simulate measured resize {paneId}</button>
      </div>
    )
  },
}))
vi.mock('./ResizablePaneLayout', () => ({
  ResizablePaneLayout: ({ layoutKey, panes }: {
    layoutKey: string
    panes: ReadonlyMap<string, React.ReactNode>
  }) => (
    <div data-testid="pane-layout" data-layout-key={layoutKey}>{[...panes.values()]}</div>
  ),
}))
vi.mock('./SimLiveView', () => ({
  SimLiveView: ({ udid, active, visible }: { udid: string; active: boolean; visible: boolean }) => {
    const canvas = useRef<HTMLCanvasElement>(null)
    useEffect(() => { if (active) canvas.current?.focus() }, [active])
    return <canvas ref={canvas} tabIndex={0} data-testid={`sim-${udid}`} data-active={String(active)} data-visible={String(visible)} />
  },
}))
vi.mock('./NativeWebViewTile', () => ({ NativeWebViewTile: ({ webPane, visible }: { webPane: { id: string }; visible: boolean }) => <div data-testid={`native-web-${webPane.id}`} data-visible={String(visible)} /> }))
vi.mock('./PaneGitStats', () => ({
  PaneGitStats: ({ onOpenChanges }: { onOpenChanges?: () => void }) => (
    <button type="button" className="pane-git-stats" aria-label="Git changes vs main: 1 files, +3 -1" onClick={onOpenChanges}>+3 −1</button>
  ),
}))
vi.mock('./SessionTree', () => ({ SessionTree: () => null }))
vi.mock('./PortsSection', () => ({ PortsSection: () => null }))

let daemonMessage: ((message: ServerMessage) => void) | undefined
let daemonConnection: ConnectionState = {
  phase: 'live',
  detail: 'Authenticated local stream',
  attempt: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  window.localStorage.clear()
  window.__commandoDesktopWindowActive = true
  const narrowMedia = new window.EventTarget() as MediaQueryList
  Object.defineProperties(narrowMedia, {
    matches: { configurable: true, get: () => window.innerWidth <= 840 },
    media: { value: NARROW_PANEL_QUERY },
  })
  narrowMedia.onchange = null
  narrowMedia.addListener = vi.fn()
  narrowMedia.removeListener = vi.fn()
  vi.stubGlobal('matchMedia', vi.fn((query: string) => query === NARROW_PANEL_QUERY ? narrowMedia : {
    matches: false, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }))
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/api/prs/prefs')) {
      return json({ prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
    }
    if (url.includes('/api/prs/repos')) return json({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] })
    if (url.includes('/api/prs/repo')) return json({ repo: null })
    if (url.includes('/api/prs')) {
      return json({ list: { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 0, pullRequests: [], truncated: false, mineTruncated: false, fetchedAt: 0 } })
    }
    if (url.includes('/api/pane-management/') && url.includes('/mark')) return json({ ok: true })
    if (url.endsWith('/rename')) return json({ ok: true })
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
  }))
  daemonMessage = undefined
  daemonConnection = {
    phase: 'live',
    detail: 'Authenticated local stream',
    attempt: 0,
  }
  appMocks.nativeConnect.mockResolvedValue({
    available: true,
    capabilities: [],
    maxPanes: 8,
  })
  appMocks.useDaemon.mockImplementation((
    _token: string,
    _sessionAuthenticated: boolean,
    onMessage: (message: ServerMessage) => void,
  ) => {
    daemonMessage = onMessage
    return { connection: daemonConnection, send: appMocks.send }
  })
  vi.mocked(getAuthBootstrap).mockResolvedValue({ enabled: false, needsOwner: false, ownerEmail: null })
  vi.mocked(getAuthUser).mockResolvedValue(null)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
  window.localStorage.clear()
  delete window.__commandoDesktopWindowActive
})

describe('owner authentication form', () => {
  it('hydrates a late bootstrap email and keeps it editable', async () => {
    const props = {
      initialError: '',
      tokenRejected: true,
      onAuthenticated: vi.fn(),
      onToken: vi.fn(),
    }
    const view = render(
      <AuthGate
        {...props}
        bootstrap={{ enabled: false, needsOwner: false, ownerEmail: null }}
      />,
    )

    view.rerender(
      <AuthGate
        {...props}
        bootstrap={{ enabled: true, needsOwner: true, ownerEmail: 'leo@ijebor.com' }}
      />,
    )

    const email = await screen.findByRole('textbox', { name: 'Email' })
    await waitFor(() => expect(email).toHaveValue('leo@ijebor.com'))
    expect(email).not.toHaveAttribute('readonly')

    fireEvent.change(email, { target: { value: 'other@example.com' } })
    expect(email).toHaveValue('other@example.com')
  })

  it('stores a manually entered token only in ephemeral session storage', () => {
    const onToken = vi.fn()
    render(
      <AuthGate
        bootstrap={{ enabled: false, needsOwner: false, ownerEmail: null }}
        initialError=""
        tokenRejected={false}
        onAuthenticated={vi.fn()}
        onToken={onToken}
      />,
    )

    fireEvent.change(screen.getByLabelText('Daemon automation token'), {
      target: { value: 'manual-window-token' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(onToken).toHaveBeenCalledWith('manual-window-token')
    expect(window.sessionStorage.getItem('commando.session-token')).toBe('manual-window-token')
    expect(window.localStorage.getItem('commando.session-token')).toBeNull()
  })
})

const pane = {
  id: '%12',
  targetId: '550e8400-e29b-41d4-a716-446655440012',
  processId: 1_200,
  index: 1,
  windowId: '@2',
  sessionId: '$3',
  title: 'api',
  command: 'node',
  path: '/tmp/project',
  active: true,
  dead: false,
  width: 100,
  height: 30,
} as TmuxPane

const adjacentPane = {
  ...pane,
  id: '%13',
  targetId: '550e8400-e29b-41d4-a716-446655440013',
  processId: 1_300,
  index: 2,
  title: 'worker',
} as TmuxPane

const remotePane = {
  ...pane,
  id: '%21',
  targetId: '550e8400-e29b-41d4-a716-446655440021',
  processId: 2_100,
  index: 1,
  windowId: '@5',
  sessionId: '$6',
  title: 'review-agent',
} as TmuxPane

function snapshotWith(panes: TmuxPane[]): CommandoSnapshot {
  return {
    revision: 1,
    capturedAt: 1,
    sessions: [{
      id: '$3',
      name: 'work',
      attached: true,
      activeWindowId: '@2',
      windowIds: ['@2'],
    }],
    windows: [{
      id: '@2',
      index: 0,
      sessionId: '$3',
      name: 'editor',
      active: true,
      layout: panes.length === 1
        ? `dbde,80x24,0,0,${panes[0]!.id.slice(1)}`
        : 'dbde,161x24,0,0{80x24,0,0,12,80x24,81,0,13}',
      paneIds: panes.map((candidate) => candidate.id),
    }],
    panes,
    ports: [],
  }
}

function snapshotAcrossSessions(): CommandoSnapshot {
  return {
    revision: 1,
    capturedAt: 1,
    sessions: [
      {
        id: '$3',
        name: 'work',
        attached: true,
        activeWindowId: '@2',
        windowIds: ['@2'],
      },
      {
        id: '$6',
        name: 'review',
        attached: false,
        activeWindowId: '@5',
        windowIds: ['@5'],
      },
    ],
    windows: [
      {
        id: '@2',
        index: 0,
        sessionId: '$3',
        name: 'editor',
        active: true,
        layout: 'dbde,80x24,0,0,12',
        paneIds: [pane.id],
      },
      {
        id: '@5',
        index: 0,
        sessionId: '$6',
        name: 'agent',
        active: true,
        layout: 'dbde,80x24,0,0,21',
        paneIds: [remotePane.id],
      },
    ],
    panes: [pane, remotePane],
    ports: [],
  }
}

async function renderAppWithSnapshot(snapshot = snapshotWith([pane, adjacentPane])) {
  window.sessionStorage.setItem('commando.session-token', 'test-token')
  const view = render(<App />)
  act(() => daemonMessage?.({ type: 'snapshot', snapshot }))
  if (snapshot.panes[0]!.empty) await screen.findByRole('region', { name: 'Empty pane' })
  else await screen.findByTestId(`renderer-${snapshot.panes[0]!.id}`)
  return view
}

describe('pane close and create shortcuts', () => {
  const deleteUrl = (id: string) => `/api/pane-management/panes/${encodeURIComponent(id)}/delete`

  it.each(['button', 'keyboard', 'native'] as const)('closes the targeted pane via %s', async (source) => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    await renderAppWithSnapshot()
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    fireEvent.focus(screen.getByTestId(`renderer-${adjacentPane.id}`))

    if (source === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close api' }))
    if (source === 'keyboard') fireEvent.keyDown(window, { key: 'w', metaKey: true })
    if (source === 'native') act(() => window.dispatchEvent(new CustomEvent('commando:native-terminal-shortcut', {
      detail: { key: 'w', metaKey: true },
    })))

    const target = source === 'button' ? pane : adjacentPane
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(deleteUrl(target.id), expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ confirmPaneId: target.id }),
    })))
    expect(confirm).toHaveBeenCalledWith(`Kill pane "${target.title}"? Its running process will be terminated.`)
  })

  it('keeps a pane when confirmation is cancelled and ignores modified or repeated shortcuts', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    await renderAppWithSnapshot()
    fireEvent.keyDown(window, { key: 'w', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'w', metaKey: true, repeat: true })
    expect(confirm).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(window, { key: 'w', metaKey: true })).toBe(false)
    expect(confirm).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/delete'), expect.anything())
  })

  it.each(['keyboard', 'native'] as const)('creates a pane in the current session via %s', async (source) => {
    await renderAppWithSnapshot(snapshotAcrossSessions())
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ created: {
      kind: 'pane', sessionId: '$3', sessionName: 'work', windowId: '@2', windowIndex: 0,
      windowName: 'editor', paneId: '%13', paneIndex: 2, panePath: pane.path,
    } }), { status: 200 }))
    if (source === 'keyboard') fireEvent.keyDown(window, { key: 't', metaKey: true })
    else act(() => window.dispatchEvent(new CustomEvent('commando:native-terminal-shortcut', {
      detail: { key: 't', metaKey: true },
    })))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tmux/panes', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        targetId: pane.id, direction: 'horizontal', placement: 'after', cwd: pane.path,
      }),
    })))
  })

  it('shows a launcher instead of a terminal for an empty pane and launches into it', async () => {
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, empty: true }]))
    expect(screen.queryByTestId(`renderer-${adjacentPane.id}`)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: `Open tabs for ${adjacentPane.title}` })).not.toBeInTheDocument()
    vi.mocked(fetch).mockResolvedValue(new Response('{"launched":true}', { status: 200 }))
    const launcher = within(screen.getByRole('group', { name: 'Start in this pane' }))

    fireEvent.click(launcher.getByRole('button', { name: 'Codex' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tmux/panes/launch', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ paneId: adjacentPane.id, agent: { provider: 'codex' } }),
    })))
    await waitFor(() => expect(launcher.getByRole('button', { name: 'Shell' })).toBeEnabled())
    fireEvent.click(launcher.getByRole('button', { name: 'Shell' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tmux/panes/launch', expect.objectContaining({
      body: JSON.stringify({ paneId: adjacentPane.id }),
    })))
  })

  it('reports failed closes and disables close controls while disconnected', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const view = await renderAppWithSnapshot()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'Unable to kill test pane' }), { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: 'Close api' }))
    await screen.findByText('Unable to kill test pane')
    daemonConnection = { phase: 'reconnecting', detail: 'Offline', attempt: 1 }
    view.rerender(<App />)
    expect(screen.getByRole('button', { name: 'Close api' })).toBeDisabled()
    vi.mocked(confirm).mockClear()
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(confirm).not.toHaveBeenCalled()
  })
})

function selectSession(paneId: string) {
  fireEvent.pointerDown(document.querySelector(`[data-pane-id="${paneId}"] .pane-head`)!)
  const rail = screen.queryByRole('button', { name: 'Open Session' })
  fireEvent.click(rail ?? screen.getByRole('tab', { name: 'Session' }))
}

it.each(['normal', 'terminal', 'other built-in', 'other web tab'] as const)('opens the focused pane Changes tab from the footer chip while %s is maximized', async (maximized) => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input)
    const value = url.includes('/api/git/summary')
      ? { isRepo: true, target: 'main', additions: 3, deletions: 1, files: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1, binary: false }] }
      : url.includes('/api/git/file-diff') ? { file: 'a.ts', diff: '' }
      : url.includes('/api/prs/pane') ? { list: { targetId: adjacentPane.targetId, pullRequests: [] } } : {}
    return new Response(JSON.stringify(value), { status: 200 })
  })
  await renderAppWithSnapshot()
  let chip = await within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`) as HTMLElement).findByRole('button', { name: /Git changes/ })
  if (maximized === 'terminal') {
    fireEvent.click(within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`) as HTMLElement).getByRole('button', { name: 'Maximize pane' }))
    chip = within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`) as HTMLElement).getByRole('button', { name: /Git changes/ })
  }
  if (maximized === 'other built-in') {
    selectSession(pane.id)
    fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
  }
  if (maximized === 'other web tab') {
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, dock: 'panel' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
  }
  fireEvent.click(chip)
  await waitFor(() => expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true'))
  expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
  expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-collapsed')
  expect(fetch).toHaveBeenCalledWith('/api/web-panes/changes/active-tab', expect.objectContaining({ body: JSON.stringify({ anchorPaneId: adjacentPane.id }) }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(document.querySelector('.side-panel')).toBeVisible()
  expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-panel-maximized')
})

describe('session update briefs', () => {
  it('keeps worklogs and personal notes available before any hook brief arrives', async () => {
    await renderAppWithSnapshot()
    selectSession(pane.id)
    expect(screen.getByLabelText('Worklog for api')).toHaveTextContent('No session brief yet.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for api' }), { target: { value: 'Waiting for agent metadata' } })
    expect(screen.getByRole('textbox', { name: 'Note for api' })).toHaveValue('Waiting for agent metadata')
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: '%12', targetId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', sessionId: '$3', sessionName: 'work',
      state: 'done', headline: 'An old owner', headlineSource: 'agent', updates: [], updatedAt: 1,
    } }))
    expect(screen.getByLabelText('Worklog for api')).not.toHaveTextContent('An old owner')
  })

  it.each(['same pane', 'other pane', 'other session'] as const)('reveals an existing simulator in a collapsed panel on the %s before focusing it', async (location) => {
    const simulator = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone 17 Pro', label: 'Review', task: 'Review', sessionName: 'work', ports: [], idle: false }
    const owner = location === 'other session' ? { ...remotePane, active: false } : location === 'other pane' ? { ...adjacentPane, active: false } : pane
    const snapshot = location === 'other session' ? snapshotAcrossSessions() : snapshotWith([pane, { ...adjacentPane, active: false }])
    if (location === 'other session') {
      const other = { ...remotePane, id: '%22', active: true }
      snapshot.panes = [pane, owner, other]
      snapshot.windows[1] = { ...snapshot.windows[1]!, paneIds: [owner.id, other.id], layout: 'dbde,161x24,0,0{80x24,0,0,21,80x24,81,0,22}' }
    }
    await renderAppWithSnapshot(snapshot)
    const browser = { ...openWebPane, dock: 'panel' as const, activeTab: true, unseen: false }
    const ownerBrowser = { ...browser, id: 'w-owner', sessionId: owner.sessionId, windowId: owner.windowId, anchorPaneId: owner.id }
    const tile = { ...ownerBrowser, id: 'w-sim', url: '', order: 1, activeTab: false, content: { kind: 'simulator' as const, udid: simulator.udid } }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: location === 'same pane' ? [browser, tile] : [browser, ownerBrowser, tile] }))
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName: 'work',
      state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator,
    } }))
    selectSession(pane.id)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    const live = await screen.findByTestId(`sim-${simulator.udid}`)
    await waitFor(() => expect(live).toBeVisible())
    await waitFor(() => expect(live).toHaveFocus())
    expect(live).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('tab', { name: 'Simulator' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.side-panel-owner')).toHaveTextContent(`${owner.id} · ${owner.title}`)
    expect(document.querySelector(`[data-pane-id="${owner.id}"] .pane-footer-focus`)).toHaveTextContent('Focused / keys go here')
    expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-collapsed')
    expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tile.id}/active-tab`, expect.objectContaining({ method: 'POST' }))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/web-panes')).toHaveLength(0)
    act(() => live.blur())
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    if (location !== 'other session') {
      fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
      await waitFor(() => expect(live).toBeVisible())
      await waitFor(() => expect(live).toHaveFocus())
    }
  })

  it.each(['before', 'after'] as const)('reveals a new simulator when its broadcast arrives %s the create response', async (timing) => {
    const simulator = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone 17 Pro', label: 'Review', task: 'Review', sessionName: 'work', ports: [], idle: false }
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, active: false }]))
    const browser = { ...openWebPane, dock: 'panel' as const, activeTab: true, unseen: false }
    const tile = { ...browser, id: 'w-new-sim', anchorPaneId: adjacentPane.id, url: '', activeTab: false, content: { kind: 'simulator' as const, udid: simulator.udid } }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser] }))
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: adjacentPane.id, targetId: adjacentPane.targetId, sessionId: adjacentPane.sessionId, sessionName: 'work',
      state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator,
    } }))
    selectSession(adjacentPane.id)
    fireEvent.focus(screen.getByTestId(`renderer-${pane.id}`))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    let respond: (value: Response) => void = () => undefined
    vi.mocked(fetch).mockImplementation(async (url) => url === '/api/web-panes'
      ? new Promise<Response>((resolve) => { respond = resolve })
      : new Response('{}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/web-panes', expect.objectContaining({
      body: JSON.stringify({ content: { kind: 'simulator', udid: simulator.udid }, anchor: adjacentPane.id }),
    })))
    if (timing === 'before') act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, tile] }))
    await act(async () => respond(new Response(JSON.stringify({ webPaneId: tile.id }), { status: 200 })))
    if (timing === 'after') act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, tile] }))
    const live = await screen.findByTestId(`sim-${simulator.udid}`)
    await waitFor(() => expect(live).toBeVisible())
    await waitFor(() => expect(live).toHaveFocus())
    expect(screen.getByRole('tab', { name: 'Simulator' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('.side-panel-owner')).toHaveTextContent(`${adjacentPane.id} · worker`)
    expect(document.querySelector(`[data-pane-id="${adjacentPane.id}"] .pane-footer-focus`)).toHaveTextContent('Focused / keys go here')
    expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tile.id}/active-tab`, expect.objectContaining({ method: 'POST' }))
  })

  it('opens the claimed simulator beside its owning pane through the existing web tile API', async () => {
    await renderAppWithSnapshot()
    const simulator = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone 17 Pro', label: 'Work · Review', task: 'Review', sessionName: 'work', ports: [{ name: 'metro', port: 8101 }], idle: false }
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName: 'work',
      state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator,
    } }))
    selectSession(pane.id)
    expect(screen.getByLabelText('Important terms for api')).toHaveTextContent('metro :8101')
    expect(screen.getByLabelText('Worklog for api')).toHaveTextContent('No session brief yet.')
    vi.mocked(fetch).mockResolvedValue(new Response('{"webPaneId":"w-test","status":"open"}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/web-panes', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ content: { kind: 'simulator', udid: simulator.udid }, anchor: pane.id }),
    })))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, id: 'w-test', url: '', content: { kind: 'simulator', udid: simulator.udid } }] }))
    const live = await screen.findByTestId(`sim-${simulator.udid}`)
    expect(live).toHaveAttribute('data-active', 'true')
    const opens = vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/web-panes').length
    act(() => live.blur())
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    await waitFor(() => expect(live).toHaveFocus())
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/web-panes')).toHaveLength(opens)
    selectSession(pane.id)
    fireEvent.click(screen.getByRole('button', { name: 'Open Simulator' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/sims/${simulator.udid}/open`, expect.objectContaining({
      method: 'POST', credentials: 'same-origin', headers: { Authorization: 'Bearer test-token' },
    })))
  })

  it('replays each worklog only into its source terminal pane', async () => {
    await renderAppWithSnapshot()
    const apiBrief: SessionBrief = {
      paneId: '%12',
      sessionId: '$3',
      sessionName: 'work',
      state: 'working',
      headline: 'API routes are ready',
      headlineSource: 'agent',
      recapMarkdown: 'API-only handoff.',
      tasks: [{ id: 'api-task', content: 'Review API output', status: 'in_progress', priority: 'high' }],
      updates: [{
        id: 'agent:1:test',
        paneId: '%12',
        kind: 'note',
        text: 'API pane updated the handoff',
        source: 'agent',
        createdAt: 1,
      }],
      next: 'Review API output',
      updatedAt: 1,
    }
    const workerBrief: SessionBrief = {
      paneId: '%13',
      sessionId: '$3',
      sessionName: 'work',
      state: 'done',
      headline: 'Worker tests passed',
      headlineSource: 'hook',
      updates: [{
        id: 'hook:13',
        paneId: '%13',
        kind: 'check',
        text: 'Worker tests passed',
        source: 'hook',
        createdAt: 2,
      }],
      updatedAt: 2,
    }

    act(() => daemonMessage?.({ type: 'session_brief_snapshot', briefs: [apiBrief, workerBrief] }))

    expect(await screen.findByLabelText('Worklog for api')).toBeInTheDocument()
    expect(screen.getByLabelText('Worklog for worker')).toBeInTheDocument()

    selectSession(pane.id)
    const apiWorklog = screen.getByLabelText('Worklog for api')
    expect(apiWorklog).toHaveTextContent('API routes are ready')
    expect(document.querySelector(`[data-pane-id="${pane.id}"] .pane-heading small`)).toHaveTextContent('API routes are ready')
    expect(document.querySelector('.terminal-pane-body .pane-worklog')).toBeNull()
    expect(document.querySelector('.terminal-pane-body.has-worklog')).toBeNull()
    expect(apiWorklog).toHaveTextContent('Review API output')
    expect(apiWorklog).not.toHaveTextContent('Worker tests passed')

    selectSession(adjacentPane.id)
    const workerWorklog = screen.getByLabelText('Worklog for worker')
    expect(workerWorklog).toHaveTextContent('Worker tests passed')
    expect(workerWorklog).not.toHaveTextContent('API routes are ready')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    expect(screen.getByLabelText('Worklog for api')).toBeInTheDocument()
    expect(screen.getByLabelText('Worklog for worker')).toBeInTheDocument()
  })
})

describe('pane marks', () => {
  it('offers pane mark commands for the active pane before terminal focus', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))

    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Search commands' }), {
      target: { value: 'Mark pane' },
    })

    expect(screen.getByRole('option', { name: /Mark pane: Waiting for PR/ })).toBeVisible()
    expect(screen.getByRole('option', { name: /Mark pane: Custom status/ })).toBeVisible()
  })

  it('sets a preset mark from the targeted pane menu', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))

    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Blocked' }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/pane-management/panes/%2512/mark',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetId: pane.targetId, label: 'Blocked', tone: 'red' }),
      }),
    ))
  })

  it('hydrates by durable target, displays activity, acknowledges it, and avoids pane-id reuse', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    const mark = {
      targetId: pane.targetId,
      label: 'Waiting for PR',
      tone: 'amber' as const,
      markedAt: 100,
      activityCount: 0,
    }

    act(() => daemonMessage?.({ type: 'pane_mark_snapshot', marks: [mark] }))
    expect(screen.getByTitle('Pane status: Waiting for PR')).toBeVisible()

    act(() => daemonMessage?.({
      type: 'pane_mark',
      mark: { ...mark, activityCount: 2, lastActivityAt: 120 },
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 2 activities since Waiting for PR was applied' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/pane-management/panes/%2512/mark/acknowledge',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ targetId: pane.targetId }) }),
    ))

    act(() => daemonMessage?.({
      type: 'snapshot',
      snapshot: snapshotWith([{ ...pane, targetId: adjacentPane.targetId }]),
    }))
    await waitFor(() => expect(screen.queryByTitle('Pane status: Waiting for PR')).not.toBeInTheDocument())

    act(() => daemonMessage?.({ type: 'pane_mark_removed', targetId: pane.targetId }))
  })
})

describe('HUD tabs', () => {
  it('switches between agents and PRs content and persists the choice', async () => {
    await renderAppWithSnapshot()
    const agentsTab = screen.getByRole('tab', { name: /Notes & Agents/ })
    const prsTab = screen.getByRole('tab', { name: 'PRs' })
    expect(agentsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Agent status filters')).toBeVisible()

    fireEvent.click(prsTab)
    expect(prsTab).toHaveAttribute('aria-selected', 'true')
    expect(window.localStorage.getItem('commando.hud.tab')).toBe('prs')
    expect(screen.getByLabelText('Agent status filters')).not.toBeVisible()
    expect(await screen.findByLabelText('Pull request filters')).toBeVisible()

    fireEvent.click(agentsTab)
    expect(window.localStorage.getItem('commando.hud.tab')).toBe('agents')
    expect(screen.getByLabelText('Agent status filters')).toBeVisible()
  })

  it('restores the persisted PRs tab on load', async () => {
    window.localStorage.setItem('commando.hud.tab', 'prs')
    await renderAppWithSnapshot()
    expect(screen.getByRole('tab', { name: 'PRs' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByLabelText('Pull request filters')).toBeVisible()
  })

  it('tracks the active and then focused pane for PR repository discovery', async () => {
    await renderAppWithSnapshot()
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/prs/repo?paneId=%2512',
      expect.any(Object),
    ))

    fireEvent.focus(screen.getByTestId('renderer-%13'))
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/prs/repo?paneId=%2513',
      expect.any(Object),
    ))
  })

  it.each(['pane pill', 'session name'])('focuses and briefly highlights the exact producing pane across sessions via the %s', async (control) => {
    const targetId = remotePane.targetId
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (value: unknown) => new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
      if (url.includes('/api/prs/prefs')) {
        return json({ prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
      }
      if (url.includes('/api/prs/repos')) return json({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] })
      if (url.includes('/api/prs/repo')) return json({ repo: null })
      if (url.includes('/api/prs')) {
        return json({ list: {
          repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 1, truncated: false,
          mineTruncated: false, fetchedAt: 0,
          pullRequests: [{
            number: 12, title: 'feat: pane marker', url: 'https://github.com/acme/widgets/pull/12',
            state: 'open', isDraft: false, author: 'leo', bodyExcerpt: '', additions: 1, deletions: 0,
            changedFiles: 1, commitCount: 1, unresolvedThreads: 0, threadsTruncated: false,
            reviewDecision: null, reviews: [], requestedReviewers: [], conflicting: false, checks: null,
            createdAt: '', updatedAt: new Date().toISOString(), headRefName: 'feat/pane-marker',
            baseRefName: 'main', headRefOid: '2222222222222222222222222222222222222222',
            baseRefOid: '1111111111111111111111111111111111111111', viewerIsAuthor: true, viewerReviewRequested: false,
            commandoMarker: { version: 1, targetId, relation: 'created' },
          }],
        } })
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    })

    await renderAppWithSnapshot(snapshotAcrossSessions())
    fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
    const jumpButton = await screen.findByRole('button', { name: 'Jump to producing pane for PR #12' })
    const footer = jumpButton.closest('article')!.querySelector('.pr-foot')!
    expect(footer).toHaveTextContent('review')
    expect(footer).not.toHaveTextContent('feat/pane-marker')

    const renamed = snapshotAcrossSessions()
    renamed.sessions[1]!.name = 'Client Onboarding flow'
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: renamed }))
    expect(footer).toHaveTextContent('Client Onboarding flow')

    const ambiguous = { ...renamed, panes: renamed.panes.map((candidate) => ({ ...candidate, targetId })) }
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: ambiguous }))
    expect(footer).toHaveTextContent('feat/pane-marker')

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([pane]) }))
    expect(footer).toHaveTextContent('feat/pane-marker')
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: renamed }))
    expect(footer).toHaveTextContent('Client Onboarding flow')

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: control === 'pane pill'
      ? 'Jump to producing pane for PR #12'
      : 'Client Onboarding flow' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    const targetPane = screen.getByTestId('renderer-%21').closest('.terminal-pane')
    expect(targetPane).toHaveClass('is-focused', 'is-jump-highlighted')
    expect(screen.queryByTestId('renderer-%12')).not.toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(PANE_JUMP_HIGHLIGHT_MS) })
    expect(targetPane).toHaveClass('is-focused')
    expect(targetPane).not.toHaveClass('is-jump-highlighted')
  })

  describe('HUD PR tab routing', () => {
    function stubPr(owned = true, ownerPane = adjacentPane, paneRepo: string | null = 'acme/widgets') {
      const pr = {
        number: 12, title: 'feat: pane diff', url: 'https://github.com/acme/widgets/pull/12',
        state: 'open', isDraft: false, author: 'leo', bodyExcerpt: '', additions: 379, deletions: 46,
        changedFiles: 1, commitCount: 1, unresolvedThreads: 0, threadsTruncated: false,
        reviewDecision: null, reviews: [], requestedReviewers: [], conflicting: false, checks: null,
        createdAt: '', updatedAt: new Date().toISOString(), headRefName: 'feat/pane-diff',
        baseRefName: 'main', headRefOid: '2'.repeat(40), baseRefOid: '1'.repeat(40), viewerIsAuthor: true, viewerReviewRequested: false,
        commandoMarker: owned ? { version: 1, targetId: ownerPane.targetId, relation: 'created' } : null,
      }
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.includes('/api/prs/prefs')) return json({ prefs: { version: 1, pinnedRepos: [], recentRepos: ['acme/widgets'], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
        if (url.includes('/api/prs/repos')) return json({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] })
        if (url.includes('/api/prs/repo')) return json({ repo: null })
        if (url.includes('/api/prs/details')) return json({ details: { body: '# PR description', headOid: pr.headRefOid, mergeTarget: { branch: 'main', oid: pr.baseRefOid }, checks: [], conversation: [] } })
        if (url.includes('/api/prs/diff')) return json({ diff: { base: pr.baseRefOid, head: pr.headRefOid, files: [], truncated: false } })
        if (url.includes('/api/prs/pane')) {
          const paneId = new URL(url, 'http://localhost').searchParams.get('paneId')
          const owner = paneId === ownerPane.id
          return json({ list: { targetId: owner ? ownerPane.targetId : pane.targetId, totalCount: owner && owned ? 1 : 0,
            pullRequests: owner && owned && paneRepo ? [{ ...pr, repo: paneRepo, preview: pr }] : [], truncated: false, fetchedAt: Date.now() } })
        }
        if (url.includes('/api/prs?')) return json({ list: { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 1, truncated: false, mineTruncated: false, fetchedAt: Date.now(), pullRequests: [pr] } })
        if (/\/api\/web-panes\/.*\/active-tab$/.test(url) || url.includes('/api/web-panes/pr-tabs/')) return json({ ok: true })
        if (url.includes('/api/git/summary')) return json({ isRepo: true, root: ownerPane.path, branch: 'feat/pane-diff', files: [] })
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
      })
      return pr
    }
    function stubColdPr() {
      const pr = stubPr()
      const fetchPr = vi.mocked(fetch).getMockImplementation()!
      let resolve!: (response: Response) => void
      let reject!: (cause: Error) => void
      const pending = new Promise<Response>((done, fail) => { resolve = done; reject = fail })
      vi.mocked(fetch).mockImplementation((input, init) => {
        const url = String(input)
        if (url.includes('/api/prs/pane') && new URL(url, 'http://localhost').searchParams.get('paneId') === adjacentPane.id) return pending.then((response) => response.clone())
        return fetchPr(input, init)
      })
      return {
        pr,
        finish: (linked = true) => resolve(new Response(JSON.stringify({ list: {
          targetId: adjacentPane.targetId, fetchedAt: Date.now(), totalCount: linked ? 1 : 0, truncated: false,
          pullRequests: linked ? [{ ...pr, repo: 'acme/widgets', preview: pr }] : [],
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        fail: () => reject(new Error('Pane PR fetch offline')),
      }
    }
    const hudPrActionLabel = (subTab: 'Description' | 'Diff') => subTab === 'Description' ? 'Quick look at PR #12' : 'Open diff for PR #12: +379 -46'
    const prTabSelections = () => vi.mocked(fetch).mock.calls.filter(([url]) => /web-panes\/pr.*\/active-tab/.test(String(url)))

    it.each(['Description', 'Diff'] as const)('opens the narrow drawer from the HUD on %s and restores a closed PR from the menu', async (subTab) => {
      vi.stubGlobal('innerWidth', 800)
      stubPr()
      await renderAppWithSnapshot()
      expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-drawer-open')
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(subTab) }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      expect(document.querySelector('.window-panel-layout')).toHaveClass('is-drawer-open')
      const panel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true'))
      fireEvent.click(screen.getByRole('button', { name: 'Close PR #12 tab' }))
      await waitFor(() => expect(screen.queryByRole('tab', { name: '#12 open' })).not.toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
      fireEvent.click(screen.getByRole('button', { name: /#12 ·/ }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      expect(document.querySelector('.window-panel-layout')).toHaveClass('is-drawer-open')
    })

    it('opens a PR from the chat strip in the pane\'s PR tab instead of the browser', async () => {
      stubPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      act(() => daemonMessage?.({ type: 'chat_state', chat: { paneId: adjacentPane.id, hostConnected: true, items: [],
        session: { paneId: adjacentPane.id, provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 1 } } }))
      const strip = await screen.findByRole('region', { name: 'Linked pull requests' })
      fireEvent.click(within(strip).getByRole('link', { name: /#12/ }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      const panel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: /Description/ })).toHaveAttribute('aria-selected', 'true'))
      expect(open).not.toHaveBeenCalled()
    })

    it.each(['Description', 'Diff'] as const)('waits for a cold startup pane cache and opens %s when the linked PR arrives', async (subTab) => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(subTab) }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(0)
      await act(async () => { cold.finish() })
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      const panel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(1)
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/prs/pane?paneId=%2513'))).toHaveLength(1)
    })
    it.each(['Description', 'Diff'] as const)('uses the %s fallback when a cold cache loads without the PR', async (subTab) => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(subTab) }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(open).not.toHaveBeenCalled()
      await act(async () => { cold.finish(false) })
      const modal = await screen.findByRole('dialog')
      expect(modal).toBeVisible()
      expect(within(modal).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true')
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(0)
    })
    it.each(['Description', 'Diff'] as const)('uses the %s fallback when a cold pane fetch fails', async (subTab) => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(subTab) }))
      await act(async () => { cold.fail() })
      const modal = await screen.findByRole('dialog')
      expect(modal).toBeVisible()
      expect(within(modal).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true')
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(0)
    })
    it.each(['Description', 'Diff'] as const)('bounds a cold %s lookup and ignores the response after falling back', async (subTab) => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      const trigger = await screen.findByRole('button', { name: hudPrActionLabel(subTab) })
      vi.useFakeTimers()
      fireEvent.click(trigger)
      await act(async () => { await vi.advanceTimersByTimeAsync(PR_PANE_LOOKUP_TIMEOUT_MS - 1) })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      const modal = screen.getByRole('dialog')
      expect(modal).toBeVisible()
      expect(within(modal).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true')
      expect(open).not.toHaveBeenCalled()
      await act(async () => { cold.finish() })
      expect(screen.getByRole('dialog')).toBeVisible()
      expect(prTabSelections()).toHaveLength(0)
      expect(document.querySelector('[data-pane-id="%12"]')).toHaveClass('is-focused')
    })
    it.each(['Description', 'Diff'] as const)('ignores an older cold action when the newest HUD action opens %s', async (subTab) => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(subTab === 'Description' ? 'Diff' : 'Description') }))
      fireEvent.click(screen.getByRole('button', { name: hudPrActionLabel(subTab) }))
      await act(async () => { cold.finish() })
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      const panel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(1)
    })
    it('suppresses the older modal fallback when a newer Diff action falls back', async () => {
      const cold = stubColdPr()
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Quick look at PR #12' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open diff for PR #12: +379 -46' }))
      await act(async () => { cold.finish(false) })
      const modal = await screen.findByRole('dialog')
      expect(within(modal).getByRole('tab', { name: /Diff/ })).toHaveAttribute('aria-selected', 'true')
      expect(within(modal).getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'false')
      expect(open).not.toHaveBeenCalled()
      expect(prTabSelections()).toHaveLength(0)
    })
    it('uses remembered broadcast dismissals and restores a linked PR from the HUD', async () => {
      const pr = stubPr()
      await renderAppWithSnapshot()
      await act(async () => { await refreshPanePrs(createPrsApi('test-token'), adjacentPane.id) })
      selectSession(adjacentPane.id)
      act(() => daemonMessage?.({ type: 'web_panes', webPanes: [], activeTabs: { [adjacentPane.id]: 'session' },
        dismissedPrTabs: { [adjacentPane.id]: { 'pr:acme:widgets:12': `open|false|${pr.updatedAt}` } } }))
      expect(screen.queryByRole('tab', { name: '#12 open' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel('Description') }))
      await waitFor(() => expect(screen.getByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true'))
      expect(fetch).toHaveBeenCalledWith('/api/web-panes/pr-tabs/restore', expect.any(Object))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it.each(['Description', 'Diff', 'menu'] as const)('restores and selects a dismissed PR via %s without a modal', async (action) => {
      const pr = stubPr()
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel('Description') }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(screen.getByRole('button', { name: 'Close PR #12 tab' }))
      await waitFor(() => expect(screen.queryByRole('tab', { name: '#12 open' })).not.toBeInTheDocument())
      expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
      expect(fetch).toHaveBeenCalledWith('/api/web-panes/pr-tabs/dismiss', expect.objectContaining({ body: JSON.stringify({ anchorPaneId: adjacentPane.id, key: 'pr:acme:widgets:12', signature: `open|false|${pr.updatedAt}`, nextKey: 'session' }) }))
      if (action === 'menu') {
        fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
        expect(screen.getByRole('heading', { name: 'Closed PRs' })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: /#12 · feat: pane diff/ }))
      } else {
        fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
        fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel(action) }))
      }
      await waitFor(() => expect(screen.getByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      const calls = vi.mocked(fetch).mock.calls
      const restoredAt = calls.findIndex(([url]) => String(url) === '/api/web-panes/pr-tabs/restore')
      expect(calls[restoredAt][1]).toEqual(expect.objectContaining({ body: JSON.stringify({ anchorPaneId: adjacentPane.id, key: 'pr:acme:widgets:12', select: true }) }))
      expect(calls.slice(restoredAt + 1).some(([url]) => /web-panes\/pr.*\/active-tab/.test(String(url)))).toBe(false)
    })

    it.each(['Session', 'web'] as const)('selects the %s neighbour immediately when dismissing a maximized PR, with one POST', async (neighbour) => {
      const pr = stubPr()
      await renderAppWithSnapshot()
      const web = { ...openWebPane, anchorPaneId: adjacentPane.id, dock: 'panel' as const, activeTab: false, unseen: false }
      if (neighbour === 'web') act(() => daemonMessage?.({ type: 'web_panes', webPanes: [web] }))
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel('Description') }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
      expect(screen.getByRole('button', { name: 'Restore panel tab' })).toBeInTheDocument()
      const callsBefore = vi.mocked(fetch).mock.calls.length
      const fetchPr = vi.mocked(fetch).getMockImplementation()!
      let finish!: (value: Response) => void
      vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/api/web-panes/pr-tabs/dismiss'
        ? new Promise((resolve) => { finish = resolve }) : fetchPr(input, init))
      fireEvent.click(screen.getByRole('button', { name: 'Close PR #12 tab' }))
      const nextLabel = neighbour === 'web' ? '127.0.0.1:41300/plan' : 'Session'
      expect(screen.getByRole('tab', { name: nextLabel })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('button', { name: 'Restore panel tab' })).toBeInTheDocument()
      expect(fetch).toHaveBeenCalledWith('/api/web-panes/pr-tabs/dismiss', expect.objectContaining({ body: JSON.stringify({
        anchorPaneId: adjacentPane.id, key: 'pr:acme:widgets:12', signature: `open|false|${pr.updatedAt}`,
        nextKey: neighbour === 'web' ? web.id : 'session',
      }) }))
      const posts = () => vi.mocked(fetch).mock.calls.slice(callsBefore).filter(([url]) => String(url).includes('/api/web-panes/'))
      expect(posts()).toHaveLength(1)
      const activeKey = neighbour === 'web' ? web.id : 'session'
      await act(async () => {
        daemonMessage?.({ type: 'web_panes', webPanes: neighbour === 'web' ? [{ ...web, activeTab: true }] : [],
          activeTabs: { [adjacentPane.id]: activeKey }, dismissedPrTabs: { [adjacentPane.id]: { 'pr:acme:widgets:12': `open|false|${pr.updatedAt}` } } })
        finish(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      })
      expect(screen.getByRole('tab', { name: nextLabel })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByRole('tab', { name: '#12 open' })).not.toBeInTheDocument()
      expect(posts()).toHaveLength(1)
    })

    it.each([false, true])('restores selection and maximization after a failed PR dismiss (maximized=%s)', async (maximized) => {
      stubPr()
      await renderAppWithSnapshot()
      const web = { ...openWebPane, anchorPaneId: adjacentPane.id, dock: 'panel' as const, activeTab: false, unseen: false }
      act(() => daemonMessage?.({ type: 'web_panes', webPanes: [web] }))
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: hudPrActionLabel('Description') }))
      const prTab = await screen.findByRole('tab', { name: '#12 open' })
      expect(prTab).toHaveAttribute('aria-selected', 'true')
      const prPanel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      expect(prPanel).toBeVisible()
      if (maximized) fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
      const fetchPr = vi.mocked(fetch).getMockImplementation()!
      let fail!: (reason: Error) => void
      vi.mocked(fetch).mockImplementation((input, init) => String(input) === '/api/web-panes/pr-tabs/dismiss'
        ? new Promise((_, reject) => { fail = reject }) : fetchPr(input, init))
      const callsBefore = vi.mocked(fetch).mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Close PR #12 tab' }))
      expect(screen.getByRole('tab', { name: '127.0.0.1:41300/plan' })).toHaveAttribute('aria-selected', 'true')
      expect(prPanel).not.toBeVisible()
      await act(async () => { fail(new Error('Dismiss failed')) })
      expect(await screen.findByText('Dismiss failed')).toBeVisible()
      expect(screen.getByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('button', { name: 'Close PR #12 tab' })).toBeVisible()
      expect(prPanel).toBeVisible()
      expect(screen.getByRole('tab', { name: '127.0.0.1:41300/plan' })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('button', { name: maximized ? 'Restore panel tab' : 'Maximize panel tab' })).toBeVisible()
      const posts = vi.mocked(fetch).mock.calls.slice(callsBefore).filter(([url]) => String(url).includes('/api/web-panes/'))
      expect(posts).toHaveLength(1)
    })

    it.each(['normal', 'terminal', 'other built-in'] as const)('opens owning PR tab from both HUD actions while %s is maximized', async (maximized) => {
      const pr = stubPr()
      await renderAppWithSnapshot()
      if (maximized === 'terminal') fireEvent.click(within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`) as HTMLElement).getByRole('button', { name: 'Maximize pane' }))
      if (maximized === 'other built-in') { selectSession(pane.id); fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' })) }
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Open diff for PR #12: +379 -46' }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      const panel = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: /Diff/ })).toHaveAttribute('aria-selected', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back to PR summary' })).not.toBeInTheDocument()
      expect(within(panel).queryByRole('button', { name: 'Jump to pane' })).not.toBeInTheDocument()
      expect(within(panel).getByText('Structural diff')).toBeVisible()
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/git/summary?paneId=%2513&target=${pr.baseRefOid}&head=${pr.headRefOid}&baseFallbackRepo=acme%2Fwidgets&baseFallbackBranch=main`, expect.any(Object)))
      expect(fetch).toHaveBeenCalledWith('/api/web-panes/pr%3Aacme%3Awidgets%3A12/active-tab', expect.objectContaining({ body: JSON.stringify({ anchorPaneId: adjacentPane.id }) }))
      // Return to the HUD and quick look explicitly selects Description on the mounted view.
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Quick look at PR #12' }))
      await waitFor(() => expect(within(panel).getByRole('tab', { name: 'Description' })).toHaveAttribute('aria-selected', 'true'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`)).toHaveClass('is-focused')
      act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([pane]) }))
      await waitFor(() => expect(document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]')).not.toBeInTheDocument())
    })
    it.each(['Description', 'Diff'] as const)('jumps across sessions and selects the owning PR on %s without sending built-in keys to tmux', async (subTab) => {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
      const pr = stubPr(true, remotePane)
      await renderAppWithSnapshot(snapshotAcrossSessions())
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: subTab === 'Description' ? 'Quick look at PR #12' : 'Open diff for PR #12: +379 -46' }))
      expect(await screen.findByRole('tab', { name: '#12 open' })).toHaveAttribute('aria-selected', 'true')
      const panel = document.querySelector('[id="panel-tab-panel:%21:pr:acme:widgets:12"]') as HTMLElement
      await waitFor(() => expect(within(panel).getByRole('tab', { name: new RegExp(subTab) })).toHaveAttribute('aria-selected', 'true'))
      if (subTab === 'Diff') {
        expect(within(panel).getByText('Structural diff')).toBeVisible()
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => {
          const url = new URL(String(input), 'http://localhost')
          return url.pathname === '/api/git/summary' && url.searchParams.get('paneId') === remotePane.id
            && url.searchParams.get('target') === pr.baseRefOid && url.searchParams.get('head') === pr.headRefOid
        })).toBe(true))
        expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/api/prs/diff'))).toBe(false)
      }
      expect(document.querySelector(`[data-pane-id="${remotePane.id}"]`)).toHaveClass('is-focused')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(fetch).toHaveBeenCalledWith('/api/web-panes/pr%3Aacme%3Awidgets%3A12/active-tab', expect.objectContaining({ body: JSON.stringify({ anchorPaneId: remotePane.id }) }))
      for (const [message] of appMocks.send.mock.calls) {
        if (message.type === 'set_window_layout' || message.type === 'apply_window_layout') expect(JSON.stringify(message)).not.toContain('pr:')
      }
    })
    it('renders and reveals the right repo when two linked PRs share a number', async () => {
      const pr = stubPr()
      const fetchPr = vi.mocked(fetch).getMockImplementation()!
      const other = { ...pr, title: 'Other repository PR', url: 'https://github.com/other/widgets/pull/12', updatedAt: '2099-01-01' }
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = String(input)
        if (url.includes('/api/prs/pane') && new URL(url, 'http://localhost').searchParams.get('paneId') === adjacentPane.id) {
          return new Response(JSON.stringify({ list: { targetId: adjacentPane.targetId, fetchedAt: Date.now(), totalCount: 2, truncated: false,
            pullRequests: [{ ...other, repo: 'other/widgets', preview: other }, { ...pr, repo: 'acme/widgets', preview: pr }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return fetchPr(input, init)
      })
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Quick look at PR #12' }))
      expect(await screen.findByRole('tab', { name: 'acme/widgets#12 open' })).toHaveAttribute('aria-selected', 'true')
      const selected = document.querySelector('[id="panel-tab-panel:%13:pr:acme:widgets:12"]') as HTMLElement
      expect(within(selected).getByRole('heading', { name: pr.title })).toBeVisible()
      expect(within(selected).getByText('acme/widgets · #12')).toBeVisible()
      fireEvent.click(screen.getByRole('tab', { name: 'other/widgets#12 open' }))
      expect(await screen.findByRole('heading', { name: other.title })).toBeVisible()
      expect(screen.getByText('other/widgets · #12')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
      expect(screen.getAllByRole('button', { name: 'Open PRs' })).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Open PRs' }))
      expect(screen.getByRole('tab', { name: 'other/widgets#12 open' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    it.each([null, 'other/widgets'])('falls back synchronously when warm pane membership is %s', async (paneRepo) => {
      const pr = stubPr(true, adjacentPane, paneRepo)
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      await act(async () => { await refreshPanePrs(createPrsApi('test-token'), adjacentPane.id) })
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Quick look at PR #12' }))
      expect(await screen.findByRole('dialog')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Close PR quick look' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open diff for PR #12: +379 -46' }))
      expect(open).toHaveBeenCalledExactlyOnceWith(pr.url, '_blank', 'noopener,noreferrer')
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => /web-panes\/pr.*\/active-tab/.test(String(url)))).toHaveLength(0)
      expect(document.querySelector('[data-pane-id="%12"]')).toHaveClass('is-focused')
    })
    it('keeps the modal and synchronous GitHub diff fallback for unowned PRs', async () => {
      const pr = stubPr(false)
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await renderAppWithSnapshot()
      fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Quick look at PR #12' }))
      expect(await screen.findByRole('dialog')).toBeVisible()
      expect(screen.queryByRole('tab', { name: '#12 open' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Close PR quick look' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open diff for PR #12: +379 -46' }))
      expect(open).toHaveBeenCalledExactlyOnceWith(pr.url, '_blank', 'noopener,noreferrer')
    })
  })
})

const openWebPane = {
  id: 'w-abcd1234',
  url: 'http://127.0.0.1:41300/plan',
  sessionId: '$3',
  windowId: '@2',
  anchorPaneId: '%12',
  placement: 'right',
  engine: 'webkit',
  openedBy: 'agent',
  openerLabel: 'claude · gizmo',
  status: 'open',
  createdAt: Date.now(),
} as const

describe('panel focus and attention', () => {
  const paneA = { ...pane, title: 'Agent A', active: true }
  const paneB = { ...adjacentPane, title: 'Agent B', active: false }
  const tabA = { ...openWebPane, dock: 'panel' as const, activeTab: true, unseen: false }
  const tabB = { ...tabA, id: 'w-1234abcd', anchorPaneId: paneB.id, url: 'http://localhost/two' }
  const owner = () => document.querySelector('.side-panel-owner')
  const footer = (id: string) => document.querySelector(`[data-pane-id="${id}"] .pane-footer-focus`)

  it.each([
    ['pointer', '.pane-head'],
    ['pointer', '.pane-heading strong'],
    ['pointer', '.pane-index'],
    ['pointer', '.pane-tab-count'],
    ['keyboard', '.pane-head'],
    ['keyboard', '[aria-label="Maximize pane"]'],
  ] as const)('focuses a pane from %s interaction on %s until the next tmux active-pane change', async (input, selector) => {
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, tabB] }))
    const target = document.querySelector(`[data-pane-id="${paneB.id}"] ${selector}`) as HTMLElement
    expect(owner()).toHaveTextContent(`${paneA.id} · Agent A`)
    if (input === 'pointer') {
      expect(fireEvent.pointerDown(target)).toBe(true)
      fireEvent.click(target)
    } else act(() => target.focus())
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
    expect(footer(paneB.id)).toHaveTextContent('Focused / keys go here')
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([{ ...paneA, active: false }, { ...paneB, active: true }]) }))
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    expect(owner()).toHaveTextContent(`${paneA.id} · Agent A`)
    fireEvent.pointerDown(target)
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
  })

  it('keeps the terminal renderer mounted when the first panel tab arrives and the last closes', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    const terminal = screen.getByTestId(`renderer-${paneA.id}`)
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA] }))
    expect(screen.getByTestId(`renderer-${paneA.id}`)).toBe(terminal)
    fireEvent.click(screen.getByRole('button', { name: 'Close 127.0.0.1:41300/plan' }))
    expect(screen.getByTestId(`renderer-${paneA.id}`)).toBe(terminal)
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('complementary', { name: 'Pane tabs' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize side panel' })).toBeInTheDocument()
  })

  it('preserves the saved active tab on the first web-panes broadcast after the snapshot', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    const later = { ...tabA, id: 'w-22222222', order: 1, activeTab: false, unseen: true, url: 'http://localhost/later' }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, later] }))
    expect(screen.getByRole('tab', { name: '127.0.0.1:41300/plan' })).toHaveAttribute('aria-selected', 'true')
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => /\/(active-tab|seen)$/.test(String(url)))).toHaveLength(0)
    expect(document.querySelector(`[data-pane-id="${paneA.id}"] .pane-tab-count`)).toHaveTextContent('2 tabs · 1 new')
  })

  it('selects the first genuinely new tab after an initially empty web-panes broadcast', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [] }))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA] }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tabA.id}/active-tab`, expect.objectContaining({ method: 'POST' })))
  })

  it.each(['collapsed', 'grid maximized'] as const)('auto-selects later DevTools tabs while %s without marking them seen', async (hidden) => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA] }))
    if (hidden === 'collapsed') fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    else fireEvent.click(document.querySelector(`[data-pane-id="${paneA.id}"] [aria-label="Maximize pane"]`) as HTMLElement)
    const devtools = { ...tabA, id: 'w-22222222', order: 1, activeTab: false, unseen: true, url: 'http://localhost/devtools/inspector.html' }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, devtools] }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${devtools.id}/active-tab`, expect.objectContaining({ method: 'POST' })))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...tabA, activeTab: false }, { ...devtools, activeTab: true }] }))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/seen'))).toHaveLength(0)
    expect(document.querySelector(`[data-pane-id="${paneA.id}"] .pane-tab-count`)).toHaveTextContent('2 tabs · 1 new')
  })

  it('marks an explicitly selected unseen tab seen through the seen endpoint', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    const later = { ...tabA, id: 'w-22222222', order: 1, activeTab: false, unseen: true, url: 'http://localhost/later' }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, later] }))
    fireEvent.click(screen.getByRole('tab', { name: /localhost\/later/ }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${later.id}/seen`, expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(document.querySelector(`[data-pane-id="${paneA.id}"] .pane-tab-count`)).not.toHaveTextContent('new'))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/seen'))).toHaveLength(1)
  })

  it.each([1, 2] as const)('optimistically closes active tab %i to the same neighbour as the server', async (index) => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    const tabs = [0, 1, 2].map((order) => ({ ...tabA, id: `w-0000000${order}`, order, activeTab: order === index, url: `http://localhost/${order}` }))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: tabs }))
    fireEvent.click(screen.getByRole('button', { name: `Close localhost/${index}` }))
    expect(screen.getByRole('tab', { name: `localhost/${index === 1 ? 2 : 1}` })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'localhost/0' })).toHaveAttribute('aria-selected', 'false')
  })

  it('lets a newer terminal click win after tmux active-pane transitions and unchanged snapshots', async () => {
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, tabB] }))
    const terminalB = screen.getByTestId(`renderer-${paneB.id}`)
    act(() => terminalB.focus())
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([{ ...paneA, active: false }, { ...paneB, active: true }]) }))
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    expect(owner()).toHaveTextContent(`${paneA.id} · Agent A`)
    expect(footer(paneA.id)).toHaveTextContent('Focused / keys go here')

    // Tmux selection changes client focus, but B still owns DOM focus. Clicking
    // B again emits pointer events without another browser focus event.
    expect(document.activeElement).toBe(terminalB)
    fireEvent.pointerDown(terminalB)
    fireEvent.click(terminalB)
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
    expect(footer(paneB.id)).toHaveTextContent('Focused / keys go here')
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
  })

  it('keeps a click newer than a tmux change received in the same render batch', async () => {
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, tabB] }))
    fireEvent.focus(screen.getByTestId(`renderer-${paneB.id}`))
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([{ ...paneA, active: false }, { ...paneB, active: true }]) }))
    act(() => {
      daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) })
      fireEvent.pointerDown(screen.getByTestId(`renderer-${paneB.id}`))
    })
    expect(owner()).toHaveTextContent(`${paneB.id} · Agent B`)
    expect(footer(paneB.id)).toHaveTextContent('Focused / keys go here')
  })

  it('clears unseen once when the pane owning the visible active tab is focused', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, { ...tabB, unseen: true }] }))
    const chip = () => document.querySelector(`[data-pane-id="${paneB.id}"] .pane-tab-count`)
    expect(chip()).toHaveTextContent(/1 tabs? · 1 new/)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(`/${tabB.id}/seen`))).toHaveLength(0)

    fireEvent.focus(screen.getByTestId(`renderer-${paneB.id}`))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tabB.id}/seen`, expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(chip()).not.toHaveTextContent('new'))
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([paneA, paneB]) }))
    fireEvent.focus(screen.getByTestId(`renderer-${paneB.id}`))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(`/${tabB.id}/seen`))).toHaveLength(1)
  })

  it('leaves a collapsed tab unseen until it becomes visible on expansion', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, { ...tabB, unseen: true }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    fireEvent.focus(screen.getByTestId(`renderer-${paneB.id}`))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(`/${tabB.id}/seen`))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Expand side panel' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tabB.id}/seen`, expect.objectContaining({ method: 'POST' })))
  })

  it('uses singular tab counts in pane headers, including unseen counts', async () => {
    await renderAppWithSnapshot(snapshotWith([paneA, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, { ...tabB, unseen: true }] }))
    expect(document.querySelector(`[data-pane-id="${paneA.id}"] .pane-tab-count`)).toHaveTextContent(/^1 tab$/)
    expect(document.querySelector(`[data-pane-id="${paneB.id}"] .pane-tab-count`)).toHaveTextContent(/^1 tab · 1 new$/)
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tabA, { ...tabB, anchorPaneId: paneA.id, unseen: false }] }))
    expect(document.querySelector(`[data-pane-id="${paneA.id}"] .pane-tab-count`)).toHaveTextContent(/^2 tabs$/)
  })
})

describe('web pane tiles', () => {
  it('does not treat a terminal sharing its layout with a web tile as solo', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    const terminal = document.querySelector('[data-pane-id="%12"]')
    expect(terminal).toHaveClass('is-solo')

    act(() => daemonMessage?.({
      type: 'web_panes',
      webPanes: [{ ...openWebPane, dock: 'split', placement: 'below' }],
    }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    expect(terminal).not.toHaveClass('is-solo')
  })

  it('keeps a lone terminal solo when its companion is a panel tab', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, dock: 'panel' }] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    // Solo height fills the one-leaf terminal grid; the panel is outside it.
    expect(document.querySelector('[data-pane-id="%12"]')).toHaveClass('is-solo')
    expect(screen.getByTestId('pane-layout').querySelector('[data-web-pane-id]')).toBeNull()
    expect(document.querySelector('.side-panel [data-web-pane-id]')).toBeInTheDocument()
  })

  it('renders a tile from a web_panes broadcast beside the tmux panes', async () => {
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))

    const frame = await screen.findByTitle('Web pane: 127.0.0.1:41300')
    expect(frame).toHaveAttribute('src', 'http://127.0.0.1:41300/plan')
    expect(screen.getByText(/opened by claude · gizmo/)).toBeInTheDocument()
    // Terminal panes are still there, in the same layout.
    expect(screen.getByTestId('renderer-%12')).toBeInTheDocument()
    expect(screen.getByTestId('renderer-%13')).toBeInTheDocument()
  })

  it('renders a chromium-engine tile as a screencast canvas with its chip', async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = []
      readonly url: string
      readyState = 0
      constructor(url: string) {
        this.url = url
        FakeWebSocket.instances.push(this)
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    try {
      await renderAppWithSnapshot()
      act(() => daemonMessage?.({
        type: 'web_panes',
        webPanes: [{ ...openWebPane, engine: 'chromium' }],
      }))

      const canvas = await screen.findByLabelText('Chromium tile: http://127.0.0.1:41300/plan')
      expect(canvas.tagName).toBe('CANVAS')
      expect(screen.getByText('chromium')).toBeInTheDocument()
      expect(screen.getByText('Starting chromium stream…')).toBeInTheDocument()
      expect(screen.getByLabelText('Open DevTools as a tile')).toBeInTheDocument()
      expect(FakeWebSocket.instances[0]?.url).toContain('/ws/web-tiles/w-abcd1234')
      // No iframe for chromium tiles — the stream is the body.
      expect(screen.queryByTitle('Web pane: 127.0.0.1:41300')).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not render tiles that belong to another window', async () => {
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({
      type: 'web_panes',
      webPanes: [{ ...openWebPane, windowId: '@9' }],
    }))
    expect(screen.queryByTitle('Web pane: 127.0.0.1:41300')).not.toBeInTheDocument()
  })

  it('closes a tile optimistically and tells the daemon', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/web-panes')) {
        expect(init?.method).toMatch(/POST|DELETE/)
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    })
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    fireEvent.click(screen.getByRole('button', { name: 'Close web pane' }))

    expect(screen.queryByTitle('Web pane: 127.0.0.1:41300')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/web-panes/w-abcd1234',
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  it('shows the pending confirm card and posts the owner decision', async () => {
    const confirmed = vi.fn()
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/confirm')) {
        confirmed(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    })
    await renderAppWithSnapshot()
    const pending = {
      ...openWebPane,
      url: 'https://reactnative.dev/docs/flatlist',
      status: 'pending' as const,
    }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [pending] }))

    expect(await screen.findByText(/wants to open/)).toBeInTheDocument()
    expect(screen.queryByTitle(/Web pane:/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Always allow/ }))
    await waitFor(() => expect(confirmed).toHaveBeenCalledWith({ allowOrigin: true }))

    // The daemon broadcasts the confirmed tile; the iframe replaces the card.
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...pending, status: 'open' as const }] }))
    expect(await screen.findByTitle('Web pane: reactnative.dev')).toBeInTheDocument()
  })

  it('maximizes a web tile to fill the canvas and restores the grid', async () => {
    // Arrange: workspace with terminal panes %1, %2 and one web tile.
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, dock: 'split' }] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    // Act: click the tile's 'Maximize web pane' button.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))

    // Assert: the canvas element has the 'maximized' class, the tile card
    // is rendered, and no terminal pane card is rendered.
    expect(document.querySelector('.workspace-canvas')).toHaveClass('maximized')
    expect(screen.getByTitle('Web pane: 127.0.0.1:41300')).toBeInTheDocument()
    expect(screen.queryByTestId('renderer-%12')).not.toBeInTheDocument()
    expect(screen.queryByTestId('renderer-%13')).not.toBeInTheDocument()

    // Act: click 'Restore web pane'.
    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))

    // Assert: the 'maximized' class is gone and both terminal panes render.
    expect(document.querySelector('.workspace-canvas')).not.toHaveClass('maximized')
    expect(screen.getByTestId('renderer-%12')).toBeInTheDocument()
    expect(screen.getByTestId('renderer-%13')).toBeInTheDocument()
  })

  it('keeps the panel mounted but hidden when a split tile is maximized', async () => {
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [
      { ...openWebPane, dock: 'split' },
      { ...openWebPane, id: 'w-1234abcd', url: 'http://localhost/panel', dock: 'panel' },
    ] }))
    const panelFrame = await screen.findByTitle('Web pane: localhost')
    const splitTile = document.querySelector(`[data-web-pane-id="${openWebPane.id}"]`) as HTMLElement
    fireEvent.click(splitTile.querySelector('[aria-label="Maximize web pane"]') as HTMLElement)
    expect(panelFrame).not.toBeVisible()
    expect(screen.getByTitle('Web pane: 127.0.0.1:41300')).toBeVisible()
    expect(document.querySelector('.side-panel')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))
    expect(screen.getByTitle('Web pane: localhost')).toBe(panelFrame)
    expect(panelFrame).toBeVisible()
  })

  it('restores focus ownership when a maximized Changes tab disappears', async () => {
    const originalSetInterval = window.setInterval.bind(window)
    const polls: (() => void)[] = []
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, timeout?: number) => {
      if (timeout === 15_000 && typeof handler === 'function') polls.push(handler as () => void)
      return originalSetInterval(handler, timeout)
    }) as typeof window.setInterval)
    let changed = true
    vi.mocked(fetch).mockImplementation(async (input) => new Response(JSON.stringify(String(input).includes('/api/git/summary')
      ? { isRepo: true, target: 'main', files: changed ? [{ path: 'a.ts', status: 'M', additions: 1, deletions: 0, binary: false }] : [] }
      : String(input).includes('/api/prs/pane') ? { list: { targetId: pane.targetId, pullRequests: [] } }
      : String(input).includes('/api/git/file-diff') ? { file: 'a.ts', diff: '' } : {}), { status: 200 }))
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, path: '/different' }]))
    fireEvent.click(within(document.querySelector(`[data-pane-id="${pane.id}"]`) as HTMLElement).getByRole('button', { name: /Git changes/ }))
    await screen.findByRole('tab', { name: /Changes/ })
    fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
    expect(document.querySelector('.window-panel-layout')).toHaveClass('is-panel-maximized')
    changed = false
    await act(async () => { polls.forEach((poll) => poll()) })
    await waitFor(() => expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-panel-maximized'))
    fireEvent.focus(screen.getByTestId(`renderer-${adjacentPane.id}`))
    expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
    intervalSpy.mockRestore()
  })

  it('labels a never-viewed Chromium tab from the web-panes broadcast', async () => {
    localStorage.setItem('commando.side-panel.collapsed.@2', 'true')
    await renderAppWithSnapshot()
    const hidden = { ...openWebPane, id: 'w-hidden', dock: 'panel' as const, engine: 'chromium' as const, anchorPaneId: adjacentPane.id, activeTab: false, unseen: true }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [hidden], activeTabs: { [adjacentPane.id]: 'session' } }))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...hidden, title: 'Shared side panel' }], activeTabs: { [adjacentPane.id]: 'session' } }))
    fireEvent.pointerDown(document.querySelector(`[data-pane-id="${adjacentPane.id}"] .pane-head`)!)
    fireEvent.click(screen.getByRole('button', { name: 'Expand side panel' }))
    const tab = screen.getByRole('tab', { name: /Shared side panel/ })
    expect(tab).toHaveAttribute('aria-selected', 'false')
    expect(within(tab).getByLabelText('New tab')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector(`[id="panel-tab-${hidden.id}"]`)).toHaveAttribute('hidden')
  })

  it('maximizes a panel tab without remounting it and restores the panel width and terminal grid', async () => {
    localStorage.setItem('commando.side-panel.width.@2', '62')
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, dock: 'panel' }] }))
    const frame = await screen.findByTitle('Web pane: 127.0.0.1:41300')
    const terminal = screen.getByTestId('renderer-%12')
    const panel = document.querySelector('.window-panel-layout') as HTMLElement
    expect(panel.style.getPropertyValue('--side-panel-width')).toBe('62%')

    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    expect(panel).toHaveClass('is-panel-maximized')
    expect(document.querySelector('.workspace-canvas')).toHaveClass('maximized')
    expect(terminal).not.toBeVisible()
    expect(screen.getByTestId('renderer-%13')).not.toBeVisible()
    expect(screen.getByTitle('Web pane: 127.0.0.1:41300')).toBe(frame)
    expect(frame).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))
    expect(panel).not.toHaveClass('is-panel-maximized')
    expect(document.querySelector('.workspace-canvas')).not.toHaveClass('maximized')
    expect(screen.getByTestId('renderer-%12')).toBe(terminal)
    expect(terminal).toBeVisible()
    expect(panel.style.getPropertyValue('--side-panel-width')).toBe('62%')
    expect(screen.getByTitle('Web pane: 127.0.0.1:41300')).toBe(frame)
  })

  it('auto-selects DevTools as the maximized panel tab and marks only the visible tab seen', async () => {
    vi.stubGlobal('WebSocket', class {
      readyState = 0
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    })
    const browser = { ...openWebPane, dock: 'panel' as const, engine: 'chromium' as const, activeTab: true, unseen: false, order: 0 }
    const hidden = { ...browser, id: 'w-hidden', engine: 'webkit' as const, url: 'http://localhost:4111/notes', activeTab: false, unseen: true, order: 1 }
    const devtools = { ...hidden, id: 'w-devtools', url: 'http://localhost:9222/devtools/inspector.html', order: 2 }
    const seenVisibility: boolean[] = []
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith(`/${devtools.id}/seen`)) {
        const tile = document.querySelector(`[data-web-pane-id="${devtools.id}"]`)
        seenVisibility.push(Boolean(tile && !tile.closest('[hidden]')))
      }
      return new Response(JSON.stringify(url.endsWith('/cdp') ? { devtoolsFrontendUrl: devtools.url } : {}), { status: 200 })
    })
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, active: false }]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, hidden] }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open DevTools as a tile' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/web-panes', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ url: devtools.url, anchor: pane.id, placement: browser.placement }),
    })))
    appMocks.send.mockClear()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, hidden, devtools] }))
    const frame = screen.getByTitle('Web pane: localhost:9222')
    expect(frame).toBeVisible()
    expect(document.querySelector('.window-panel-layout')).toHaveClass('is-panel-maximized')
    expect(screen.getByTestId('renderer-%12')).not.toBeVisible()
    expect(screen.getByRole('tab', { name: /localhost:9222/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${devtools.id}/active-tab`, expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(seenVisibility).toEqual([true]))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(`/${hidden.id}/seen`))).toHaveLength(0)
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...browser, activeTab: false }, hidden, { ...devtools, activeTab: true, unseen: false }] }))
    expect(frame).toBeVisible()
    expect(document.querySelector(`[data-web-pane-id="${browser.id}"]`)).not.toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Simulate measured resize %12', hidden: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))
    expect(screen.getByTestId('renderer-%12')).toBeVisible()
    expect(frame).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Simulate measured resize %12' }))
    fireEvent.click(screen.getByRole('button', { name: 'Simulate measured resize %13' }))
    await waitFor(() => expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'apply_window_layout', windowId: pane.windowId,
    })))
    for (const [message] of appMocks.send.mock.calls) {
      expect(JSON.stringify(message)).not.toContain(browser.id)
      expect(JSON.stringify(message)).not.toContain(devtools.id)
      expect(JSON.stringify(message)).not.toContain(hidden.id)
    }
  })

  it('keeps a newly selected tab of another pane unseen behind the maximized panel tab', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const paneB = { ...adjacentPane, active: false }
    const browser = { ...openWebPane, dock: 'panel' as const, activeTab: true, unseen: false }
    await renderAppWithSnapshot(snapshotWith([pane, paneB]))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser] }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([{ ...pane, active: false }, { ...paneB, active: true }]) }))
    const later = { ...browser, id: 'w-other', url: 'http://localhost:4111/later', anchorPaneId: paneB.id, activeTab: false, unseen: true }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, later] }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${later.id}/active-tab`, expect.objectContaining({ method: 'POST' })))
    expect(screen.getByTitle('Web pane: 127.0.0.1:41300')).toBeVisible()
    expect(screen.getByTitle('Web pane: localhost:4111')).not.toBeVisible()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/seen'))).toHaveLength(0)
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [browser, { ...later, activeTab: true }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${later.id}/seen`, expect.objectContaining({ method: 'POST' })))
    expect(screen.getByTitle('Web pane: localhost:4111')).toBeVisible()
  })

  it.each(['split', 'panel'] as const)('never leaks a %s web tile id into daemon protocol messages while maximized', async (dock) => {
    // Arrange: workspace with terminal panes %12, %13 and one web tile.
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...openWebPane, dock }] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')
    appMocks.send.mockClear()

    const assertNoWebIdLeaked = () => {
      for (const call of appMocks.send.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(openWebPane.id)
        const message = call[0] as { type?: string; paneIds?: string[]; paneId?: string }
        if (message.type === 'subscribe') {
          expect(message.paneIds?.some((id) => id.startsWith('w-'))).toBe(false)
        }
        if (message.type === 'release_resize' || message.type === 'resize_pane') {
          expect(message.paneId?.startsWith('w-')).toBe(false)
        }
      }
    }

    // Act: maximize the web tile.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize web pane' }))
    if (dock === 'panel') fireEvent.click(screen.getByRole('button', { name: 'Simulate measured resize %12', hidden: true }))
    assertNoWebIdLeaked()

    // Act: restore the grid.
    fireEvent.click(screen.getByRole('button', { name: 'Restore web pane' }))
    assertNoWebIdLeaked()
  })
})

function stubClientRect(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  } as DOMRect)
}

function stubDataTransfer() {
  return { effectAllowed: '', dropEffect: '', setData: () => {} }
}

function leafPaneOrder(spec: LayoutSpec): string[] {
  return spec.kind === 'pane' ? [spec.paneId] : spec.children.flatMap(leafPaneOrder)
}

describe('pane grid drag and drop', () => {
  it('re-anchors a web tile dropped on the bottom half of a terminal pane', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/web-panes') && url.includes('/move')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    })
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    const tileHeader = screen.getByTitle('Drag onto a terminal pane to move this tile')
    fireEvent.dragStart(tileHeader, { dataTransfer: stubDataTransfer() })

    const targetCard = document.querySelector('[data-pane-id="%13"]') as HTMLElement
    stubClientRect(targetCard, { left: 0, top: 0, width: 400, height: 300 })

    fireEvent.dragOver(targetCard, { clientX: 100, clientY: 280, dataTransfer: stubDataTransfer() })

    const preview = targetCard.querySelector('.pane-drop-preview.is-below')
    expect(preview).not.toBeNull()
    expect(preview).toHaveAttribute('data-native-terminal-occluder', '')

    fireEvent.drop(targetCard, { clientX: 100, clientY: 280, dataTransfer: stubDataTransfer() })

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/web-panes/w-abcd1234/move',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ anchor: '%13', placement: 'below' }),
        }),
      )
    })
    expect(targetCard.querySelector('.pane-drop-preview')).toBeNull()
  })

  it('keeps terminal-pane drops on the swap path', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    await renderAppWithSnapshot()

    const sourceHeader = document.querySelector('[data-pane-id="%12"] .pane-head') as HTMLElement
    fireEvent.dragStart(sourceHeader, { dataTransfer: stubDataTransfer() })

    const targetCard = document.querySelector('[data-pane-id="%13"]') as HTMLElement
    fireEvent.dragOver(targetCard, { dataTransfer: stubDataTransfer() })
    fireEvent.drop(targetCard, { dataTransfer: stubDataTransfer() })

    await waitFor(() => {
      expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'set_window_layout',
        windowId: '@2',
      }))
    })
    const layoutCall = appMocks.send.mock.calls.find((call) => (call[0] as { type?: string })?.type === 'set_window_layout')
    const spec = (layoutCall?.[0] as { spec: LayoutSpec }).spec
    expect(leafPaneOrder(spec)).toEqual(['%13', '%12'])

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/web-panes'))).toBe(false)
  })
})

describe('webPaneUrlFromQuery', () => {
  it('accepts full urls, localhost shorthands, and port shorthands', async () => {
    const { webPaneUrlFromQuery } = await import('./App')
    expect(webPaneUrlFromQuery('https://reactnative.dev/docs')).toBe('https://reactnative.dev/docs')
    expect(webPaneUrlFromQuery('localhost:5173')).toBe('http://localhost:5173/')
    expect(webPaneUrlFromQuery(':41300/plan')).toBe('http://localhost:41300/plan')
    expect(webPaneUrlFromQuery('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('rejects non-url palette queries', async () => {
    const { webPaneUrlFromQuery } = await import('./App')
    expect(webPaneUrlFromQuery('open session')).toBeNull()
    expect(webPaneUrlFromQuery('theme')).toBeNull()
    expect(webPaneUrlFromQuery('')).toBeNull()
    expect(webPaneUrlFromQuery('notaurl:5173')).toBeNull()
  })
})

describe('run command palette action', () => {
  it('parses only commands with a non-empty run suffix', async () => {
    const { runCommandFromQuery } = await import('./App')
    expect(runCommandFromQuery('run open .')).toBe('open .')
    expect(runCommandFromQuery(' RUN   npm test ')).toBe('npm test')
    expect(runCommandFromQuery('run')).toBeNull()
    expect(runCommandFromQuery('runner open .')).toBeNull()
  })

  it('runs from the focused visible pane without sending terminal input', async () => {
    await renderAppWithSnapshot()
    fireEvent.focus(screen.getByTestId('renderer-%13'))
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    const input = await screen.findByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'run open .' } })
    expect(screen.getByRole('option', { name: /Run open \.Run from \/tmp\/project/ })).toBeVisible()
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/pane-management/panes/%2513/run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ command: 'open .' }),
      }),
    ))
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(appMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }))
  })

  it('renames the selected session', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('  focused-work  ')
    await renderAppWithSnapshot()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    const input = await screen.findByRole('textbox', { name: 'Search commands' })
    fireEvent.change(input, { target: { value: 'rename session' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(prompt).toHaveBeenCalledWith('Rename tmux session', 'work')
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/session-management/sessions/%243/rename',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'focused-work' }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      }),
    ))
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
  })
})

describe('desktop resize authority', () => {
  it('keeps focused split weights stable across tmux resize echoes', async () => {
    await renderAppWithSnapshot()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web owns tmux' }))
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    const layout = screen.getByTestId('pane-layout')
    const tmuxLayoutKey = layout.getAttribute('data-layout-key')

    fireEvent.focus(renderer)

    await waitFor(() => expect(renderer).toHaveAttribute('data-resize-owner', 'true'))
    const focusedLayoutKey = layout.getAttribute('data-layout-key')
    expect(focusedLayoutKey).not.toBe(tmuxLayoutKey)

    act(() => daemonMessage?.({
      type: 'snapshot',
      snapshot: {
        ...snapshotWith([
          { ...pane, width: 159 },
          { ...adjacentPane, width: 161 },
        ]),
        revision: 2,
        windows: [{
          ...snapshotWith([pane, adjacentPane]).windows[0]!,
          layout: 'dbde,321x24,0,0{159x24,0,0,12,161x24,160,0,13}',
        }],
      },
    }))

    await waitFor(() => expect(layout).toHaveAttribute('data-layout-key', focusedLayoutKey))
  })

  it('releases all leases on resign-key and republishes ownership on focus', async () => {
    await renderAppWithSnapshot()
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    expect(renderer).toHaveAttribute('data-resize-owner', 'true')
    const initialMeasurementKey = renderer.getAttribute('data-measurement-key')

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: false }))
    })

    await waitFor(() => expect(renderer).toHaveAttribute('data-resize-owner', 'false'))
    expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'release_all_resizes' }))
    expect(renderer.getAttribute('data-measurement-key')).toContain('inactive-window')

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: true }))
    })

    await waitFor(() => expect(renderer).toHaveAttribute('data-resize-owner', 'true'))
    // The measurement key tracks window activity and settles back to its
    // active form; ownership republish rides the resizeOwner flip, not a
    // key rotation.
    await waitFor(() => {
      expect(renderer.getAttribute('data-measurement-key')).toBe(initialMeasurementKey)
    })
    expect(initialMeasurementKey).toContain('active-window')
  })

  it('keeps resize authority when focus moves from the web view to a native terminal', async () => {
    await renderAppWithSnapshot()
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    expect(renderer).toHaveAttribute('data-resize-owner', 'true')
    appMocks.send.mockClear()

    act(() => window.dispatchEvent(new Event('blur')))

    expect(renderer).toHaveAttribute('data-resize-owner', 'true')
    expect(appMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'release_all_resizes',
    }))
  })

  it('replays cached measurements when a busy lease retry fires', async () => {
    await renderAppWithSnapshot()
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    const applyLayoutCalls = () => appMocks.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'apply_window_layout')

    // The layout apply waits for a measurement from every leaf pane.
    fireEvent.click(screen.getByText(`Simulate measured resize ${pane.id}`))
    fireEvent.click(screen.getByText(`Simulate measured resize ${adjacentPane.id}`))
    await waitFor(() => expect(applyLayoutCalls()).toHaveLength(1))
    const applied = applyLayoutCalls()[0] as { spec: unknown }

    // The busy retry must re-send the same measured layout: native panes emit
    // no fresh resize echo for an unchanged grid, so the cache is all we have.
    act(() => daemonMessage?.({
      type: 'error',
      code: 'resize_window_busy',
      message: 'Another desktop window owns this tmux window',
    }))
    await waitFor(() => expect(applyLayoutCalls()).toHaveLength(2))
    expect(applyLayoutCalls()[1].spec).toEqual(applied.spec)

    // Retries never rotate the measurement key — replay, not re-measure.
    expect(renderer.getAttribute('data-measurement-key')).not.toContain('retry')
  })

  it('applies the tile anchor actual measured grid size to tmux', async () => {
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))

    fireEvent.click(screen.getByText(`Simulate measured resize ${pane.id}`))
    fireEvent.click(screen.getByText(`Simulate measured resize ${adjacentPane.id}`))

    await waitFor(() => expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'apply_window_layout',
      spec: {
        kind: 'split',
        direction: 'row',
        children: [
          { kind: 'pane', paneId: pane.id, cols: 150, rows: 40 },
          { kind: 'pane', paneId: adjacentPane.id, cols: 150, rows: 40 },
        ],
      },
    })))
  })

  it('does not retry a busy lease after the desktop window resigns key', async () => {
    await renderAppWithSnapshot()
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    const applyLayoutCount = () => appMocks.send.mock.calls
      .filter(([message]) => message.type === 'apply_window_layout').length

    fireEvent.click(screen.getByText(`Simulate measured resize ${pane.id}`))
    fireEvent.click(screen.getByText(`Simulate measured resize ${adjacentPane.id}`))
    await waitFor(() => expect(applyLayoutCount()).toBe(1))

    act(() => {
      window.dispatchEvent(new CustomEvent(DESKTOP_WINDOW_ACTIVITY_EVENT, { detail: false }))
      daemonMessage?.({
        type: 'error',
        code: 'resize_window_busy',
        message: 'Stale contention after resign-key',
      })
    })
    await waitFor(() => expect(renderer).toHaveAttribute('data-resize-owner', 'false'))
    await new Promise((resolve) => window.setTimeout(resolve, 250))

    expect(applyLayoutCount()).toBe(1)
    expect(renderer).toHaveAttribute('data-resize-owner', 'false')
  })

  it('releases leases before changing the selected tmux session', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    appMocks.send.mockClear()
    const nextPane = {
      ...pane,
      id: '%22',
      processId: 2_200,
      windowId: '@4',
      sessionId: '$4',
    }
    const nextSnapshot: CommandoSnapshot = {
      ...snapshotWith([nextPane]),
      revision: 2,
      sessions: [{
        id: '$4',
        name: 'other',
        attached: true,
        activeWindowId: '@4',
        windowIds: ['@4'],
      }],
      windows: [{
        id: '@4',
        index: 0,
        sessionId: '$4',
        name: 'other',
        active: true,
        layout: 'dbde,80x24,0,0,22',
        paneIds: [nextPane.id],
      }],
    }

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: nextSnapshot }))

    await waitFor(() => expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'release_all_resizes',
      requestId: expect.stringContaining('session-release'),
    })))
  })

  it('releases leases when the page is hidden for window close', async () => {
    await renderAppWithSnapshot()
    appMocks.send.mockClear()

    act(() => window.dispatchEvent(new Event('pagehide')))

    expect(appMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'release_all_resizes' }))
  })
})

describe('session sidebar width', () => {
  it('resizes with pointer capture, saves the width, and restores it after remount', async () => {
    const { unmount } = await renderAppWithSnapshot()
    const handle = screen.getByRole('separator', { name: 'Resize session sidebar' })
    const cockpit = document.querySelector<HTMLElement>('.cockpit')!
    handle.setPointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { pointerId: 4, button: 0 })
    expect(handle.setPointerCapture).toHaveBeenCalledWith(4)
    fireEvent.pointerMove(handle, { pointerId: 4, clientX: 350 })
    expect(cockpit.style.getPropertyValue('--left-panel-width')).toBe('350px')
    fireEvent.pointerUp(handle, { pointerId: 4 })
    expect(window.localStorage.getItem('commando.panel.left-width')).toBe('350')
    unmount()

    await renderAppWithSnapshot()
    expect(document.querySelector<HTMLElement>('.cockpit')!.style.getPropertyValue('--left-panel-width')).toBe('350px')
  })

  it('supports keyboard adjustment, bounds, and reset', async () => {
    await renderAppWithSnapshot()
    const handle = screen.getByRole('separator', { name: 'Resize session sidebar' })
    handle.setPointerCapture = vi.fn()
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(handle).toHaveAttribute('aria-valuenow', '270')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle).toHaveAttribute('aria-valuenow', '230')
    fireEvent.pointerDown(handle, { pointerId: 7, button: 0 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 900 })
    fireEvent.pointerUp(handle, { pointerId: 7 })
    expect(handle).toHaveAttribute('aria-valuenow', '480')
    fireEvent.doubleClick(handle)
    expect(handle).toHaveAttribute('aria-valuenow', '230')
    expect(window.localStorage.getItem('commando.panel.left-width')).toBe('230')
  })
})

describe('responsive drawer native occlusion', () => {
  it('retains the scrim occluder until the closing drawer transition ends', async () => {
    await renderAppWithSnapshot()
    fireEvent.click(screen.getByRole('button', { name: 'Open session tree' }))
    const scrim = screen.getByRole('button', { name: 'Close open panel' })
    const sidebar = document.querySelector<HTMLElement>('.session-sidebar')!
    expect(scrim).toHaveAttribute('data-native-terminal-occluder')
    expect(sidebar).toHaveClass('panel-open')

    fireEvent.click(scrim)
    expect(sidebar).not.toHaveClass('panel-open')
    expect(scrim).toHaveAttribute('data-native-terminal-occluder')

    fireEvent.transitionEnd(sidebar, { propertyName: 'transform' })
    await waitFor(() => expect(scrim).not.toHaveAttribute('data-native-terminal-occluder'))
  })

  it('releases drawer occlusion after the fallback when no transition event fires', async () => {
    await renderAppWithSnapshot()
    fireEvent.click(screen.getByRole('button', { name: 'Open HUD' }))
    const scrim = screen.getByRole('button', { name: 'Close open panel' })
    expect(scrim).toHaveAttribute('data-native-terminal-occluder')

    fireEvent.click(scrim)
    expect(scrim).toHaveAttribute('data-native-terminal-occluder')
    await waitFor(
      () => expect(scrim).not.toHaveAttribute('data-native-terminal-occluder'),
      { timeout: 1_000 },
    )
  })
})

const paneProps = {
  pane,
  index: 0,
  count: 1,
  solo: true,
  preset: 'equal-grid' as const,
  maximized: false,
  focused: false,
  jumpHighlighted: false,
  resizeOwner: false,
  measurementKey: 'layout',
  fillIncompleteRows: false,
  connected: true,
  renaming: false,
  nativeRetryKey: 0,
  useXtermFallback: false,
  gitApi: {
    summary: vi.fn().mockResolvedValue({ isRepo: false }),
    fileDiff: vi.fn().mockResolvedValue({ file: '', diff: '' }),
    search: vi.fn().mockResolvedValue({ query: '', matches: [], files: [], totalMatches: 0, matchingFiles: 0, truncated: false }),
    repo: vi.fn().mockResolvedValue({ isRepo: false }),
    branches: vi.fn().mockResolvedValue({ isRepo: false }),
  },
  onOpenPath: vi.fn().mockResolvedValue(undefined),
  onSelectBriefPane: vi.fn(),
  onFocus: vi.fn(),
  onOpenMenu: vi.fn(),
  onRename: vi.fn().mockResolvedValue(undefined),
  onRenameFinished: vi.fn(),
  onMove: vi.fn(),
  onMaximize: vi.fn(),
  onClose: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  dropPreview: null,
  onInput: vi.fn(),
  onInputBytes: vi.fn(),
  onKey: vi.fn(),
  onPaste: vi.fn(),
  onResize: vi.fn(),
  onRequestReset: vi.fn(),
  onRendererChange: vi.fn(),
  registerSink: vi.fn(() => () => undefined),
  registerFocusable: vi.fn(),
}

describe('terminal pane actions', () => {
  it('focuses on header pointerdown while preserving dragging, the keyboard menu and header buttons', () => {
    const onFocus = vi.fn(), onDragStart = vi.fn(), onDragEnd = vi.fn(), onOpenMenu = vi.fn()
    const onMove = vi.fn(), onMaximize = vi.fn(), onClose = vi.fn()
    const view = render(<TerminalPaneCard {...paneProps} index={1} count={2}
      onFocus={onFocus} onDragStart={onDragStart} onDragEnd={onDragEnd} onOpenMenu={onOpenMenu}
      onMove={onMove} onMaximize={onMaximize} onClose={onClose} />)
    const header = view.container.querySelector('.pane-head') as HTMLElement
    expect(header).toHaveAttribute('draggable', 'true')
    expect(fireEvent.pointerDown(header)).toBe(true)
    expect(onFocus).toHaveBeenCalled()
    fireEvent.dragStart(header, { dataTransfer: stubDataTransfer() })
    fireEvent.dragEnd(header)
    expect(onDragStart).toHaveBeenCalledOnce()
    expect(onDragEnd).toHaveBeenCalledOnce()
    act(() => header.focus())
    fireEvent.keyDown(header, { key: 'F10', shiftKey: true })
    expect(onOpenMenu).toHaveBeenCalledWith(24, 0)
    for (const name of ['Move api left', 'Maximize pane', 'Close api']) {
      const button = screen.getByRole('button', { name })
      expect(fireEvent.pointerDown(button)).toBe(true)
      fireEvent.click(button)
    }
    expect(onMove).toHaveBeenCalledWith(-1)
    expect(onMaximize).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('bounds a maximized pane to the layout so a long chat cannot push the Restore button off screen', () => {
    const css = readFileSync('src/styles.css', 'utf8')
    expect(css).toMatch(/\.terminal-pane\.is-maximized\s*\{[^}]*\bheight:\s*100%;/)
    expect(css).not.toMatch(/\.terminal-pane\.is-maximized\s*\{[^}]*min-height:\s*100%;/)
  })

  it('renders a semantic pane rail and acknowledges post-mark activity without clearing the label', () => {
    const onAcknowledgeMark = vi.fn()
    const view = render(
      <TerminalPaneCard
        {...paneProps}
        mark={{
          targetId: pane.targetId,
          label: 'Waiting for PR',
          tone: 'amber',
          markedAt: 100,
          activityCount: 3,
          lastActivityAt: 120,
        }}
        onAcknowledgeMark={onAcknowledgeMark}
      />,
    )

    expect(view.container.querySelector('.terminal-pane')).toHaveClass('has-pane-mark', 'tone-amber', 'has-pane-mark-activity')
    expect(screen.getByTitle('Pane status: Waiting for PR')).toHaveTextContent('Waiting for PR')
    const alarm = screen.getByRole('button', { name: 'Acknowledge 3 activities since Waiting for PR was applied' })
    expect(alarm).toHaveAttribute('aria-live', 'polite')
    fireEvent.click(alarm)
    expect(onAcknowledgeMark).toHaveBeenCalledOnce()
    expect(screen.getByText('Waiting for PR')).toBeVisible()
  })

  it('confirms when a terminal selection is copied', () => {
    render(<TerminalPaneCard {...paneProps} />)

    fireEvent.click(screen.getByRole('button', { name: 'Simulate terminal selection copy' }))

    expect(screen.getByRole('status')).toHaveTextContent('Copied')
    expect(screen.getByRole('status')).toHaveAttribute('data-native-terminal-occluder')
  })

  it('marks pane action errors as native terminal occluders', () => {
    const onDismiss = vi.fn()
    render(<PaneActionErrorFeedback message="Unable to split pane" onDismiss={onDismiss} />)

    expect(screen.getByRole('alert')).toHaveAttribute('data-native-terminal-occluder')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss pane action error' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('opens path actions and copies the pane path to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<TerminalPaneCard {...paneProps} />)

    fireEvent.click(screen.getByRole('button', { name: `Path actions for ${pane.path}` }))
    expect(screen.getByRole('menu', { name: `Path actions for ${pane.path}` })).toBeVisible()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(pane.path))
    expect(screen.getByText('Copied')).toBeVisible()
  })

  it('opens the pane folder from the path actions', async () => {
    const onOpenPath = vi.fn().mockResolvedValue(undefined)
    render(<TerminalPaneCard {...paneProps} onOpenPath={onOpenPath} />)

    fireEvent.click(screen.getByRole('button', { name: `Path actions for ${pane.path}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }))

    await waitFor(() => expect(onOpenPath).toHaveBeenCalledOnce())
    expect(screen.queryByRole('menu', { name: `Path actions for ${pane.path}` })).not.toBeInTheDocument()
    expect(screen.getByText('Opened')).toBeVisible()
  })

  it('leaves an unmodified right click to the terminal application', () => {
    const onOpenMenu = vi.fn()
    const onFocus = vi.fn()
    const view = render(
      <TerminalPaneCard {...paneProps} onFocus={onFocus} onOpenMenu={onOpenMenu} />,
    )

    fireEvent.contextMenu(view.container.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
    })

    expect(onOpenMenu).not.toHaveBeenCalled()
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('leaves Command-right click to the terminal application', () => {
    const onOpenMenu = vi.fn()
    const onFocus = vi.fn()
    const view = render(
      <TerminalPaneCard {...paneProps} onFocus={onFocus} onOpenMenu={onOpenMenu} />,
    )

    fireEvent.contextMenu(view.container.querySelector('[data-pane-id="%12"]')!, {
      metaKey: true,
    })

    expect(onOpenMenu).not.toHaveBeenCalled()
    expect(onFocus).not.toHaveBeenCalled()
  })

  it('opens the context menu for the targeted pane on Option-right click', () => {
    const onOpenMenu = vi.fn()
    const onFocus = vi.fn()
    const view = render(
      <TerminalPaneCard {...paneProps} onFocus={onFocus} onOpenMenu={onOpenMenu} />,
    )

    fireEvent.contextMenu(view.container.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })

    expect(onOpenMenu).toHaveBeenCalledWith(120, 80)
    expect(onFocus).toHaveBeenCalled()
  })

  it('renames the pane inline', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined)
    const onRenameFinished = vi.fn()
    render(
      <TerminalPaneCard
        {...paneProps}
        renaming
        onRename={onRename}
        onRenameFinished={onRenameFinished}
      />,
    )

    const input = await screen.findByRole('textbox', { name: 'Rename api' })
    fireEvent.change(input, { target: { value: 'api tests' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('api tests'))
    await waitFor(() => expect(onRenameFinished).toHaveBeenCalled())
  })
})

describe('pane renderer overrides', () => {
  it('restores terminal focus when the pane menu is dismissed', async () => {
    await renderAppWithSnapshot()
    const renderer = screen.getByTestId('renderer-%12')

    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })
    await screen.findByRole('menu')
    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await waitFor(() => expect(renderer).toHaveFocus())
  })

  it('switches only the selected pane and reverses locally while offline', async () => {
    const view = await renderAppWithSnapshot()

    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use xterm fallback' }))

    expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'true')
    expect(screen.getByTestId('renderer-%13')).toHaveAttribute('data-xterm-fallback', 'false')

    daemonConnection = {
      phase: 'reconnecting',
      detail: 'Reconnecting locally',
      attempt: 1,
    }
    view.rerender(<App />)
    appMocks.send.mockClear()
    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })
    const useNative = screen.getByRole('menuitem', { name: 'Use native terminal' })
    expect(useNative).toBeEnabled()
    fireEvent.click(useNative)

    expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'false')
    expect(screen.getByTestId('renderer-%13')).toHaveAttribute('data-xterm-fallback', 'false')
    expect(appMocks.send).not.toHaveBeenCalled()
  })

  it('shows automatic xterm fallback and retries only the failed pane', async () => {
    await renderAppWithSnapshot()
    fireEvent.click(screen.getByRole('button', { name: 'Simulate native failure %12' }))
    await waitFor(() => {
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-renderer', 'xterm')
    })

    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      altKey: true,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use native terminal' }))

    await waitFor(() => {
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-renderer', 'native')
    })
    expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-native-retry-key', '1')
    expect(screen.getByTestId('renderer-%13')).toHaveAttribute('data-renderer', 'native')
    expect(screen.getByTestId('renderer-%13')).toHaveAttribute('data-native-retry-key', '0')
  })

  it('prunes an override when its pane ID is removed', async () => {
    await renderAppWithSnapshot()
    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      altKey: true,
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use xterm fallback' }))
    expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'true')

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([adjacentPane]) }))
    await waitFor(() => expect(screen.queryByTestId('renderer-%12')).not.toBeInTheDocument())

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([pane, adjacentPane]) }))
    await waitFor(() => {
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'false')
    })
  })

  it('does not carry an override into a replacement pane with the same tmux ID', async () => {
    await renderAppWithSnapshot()
    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      altKey: true,
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use xterm fallback' }))
    expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'true')

    const replacement = {
      ...pane,
      processId: 9_912,
      title: 'replacement',
    }
    act(() => daemonMessage?.({
      type: 'snapshot',
      snapshot: { ...snapshotWith([replacement, adjacentPane]), revision: 2, capturedAt: 2 },
    }))

    await waitFor(() => {
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'false')
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-native-retry-key', '0')
    })
  })

  it('clears transient renderer state when the daemon snapshot revision rolls back', async () => {
    await renderAppWithSnapshot({ ...snapshotWith([pane, adjacentPane]), revision: 8 })
    fireEvent.contextMenu(document.querySelector('[data-pane-id="%12"]')!, {
      altKey: true,
    })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Use xterm fallback' }))

    act(() => daemonMessage?.({
      type: 'snapshot',
      snapshot: { ...snapshotWith([pane, adjacentPane]), revision: 1, capturedAt: 20 },
    }))

    await waitFor(() => {
      expect(screen.getByTestId('renderer-%12')).toHaveAttribute('data-xterm-fallback', 'false')
    })
  })
})

describe('side panel dock changes and reopens', () => {
  it.each([false, true])('splits a tab and returns it without changing panel width or remounting terminals (maximized: %s)', async (maximized) => {
    localStorage.setItem('commando.side-panel.width.@2', '62')
    await renderAppWithSnapshot()
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const tab = { ...openWebPane, dock: 'panel' as const, order: 0, unseen: false, activeTab: true }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tab], activeTabs: { [pane.id]: tab.id } }))
    const terminal = screen.getByTestId(`renderer-${pane.id}`)
    const layout = document.querySelector('.window-panel-layout') as HTMLElement
    if (maximized) fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
    fireEvent.click(screen.getByRole('button', { name: 'Split out' }))
    expect(layout).not.toHaveClass('is-panel-maximized')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tab.id}/dock`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ dock: 'split', anchorSize: { cols: pane.width, rows: pane.height } }),
    })))
    const split = { ...tab, dock: 'split' as const, placement: 'right' as const, activeTab: false, layoutState: 'pending' as const, anchorSize: { cols: pane.width, rows: pane.height } }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [split], activeTabs: { [pane.id]: 'session' } }))
    const tile = document.querySelector(`[data-web-pane-id="${tab.id}"]`)
    expect(tile?.closest('.window-terminal-grid')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    expect(layout).not.toHaveClass('is-collapsed')
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('62%')
    expect(screen.getByTestId(`renderer-${pane.id}`)).toBe(terminal)
    fireEvent.click(screen.getByRole('button', { name: 'Back to panel' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tab.id}/dock`, expect.objectContaining({ body: JSON.stringify({ dock: 'panel' }) })))
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...tab, layoutState: 'settled' }], activeTabs: { [pane.id]: tab.id } }))
    expect(document.querySelector(`[data-web-pane-id="${tab.id}"]`)?.closest('.side-panel')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /127.0.0.1:41300\/plan/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByLabelText('New tab')).not.toBeInTheDocument()
    expect(layout.style.getPropertyValue('--side-panel-width')).toBe('62%')
    expect(screen.getByTestId(`renderer-${pane.id}`)).toBe(terminal)
    selectSession(pane.id)
    expect(screen.queryByRole('button', { name: 'Split out' })).not.toBeInTheDocument()
  })

  it.each([true, false])('treats an existing id as an agent open when its pane is focused: %s', async (focused) => {
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, active: false }]))
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const anchor = focused ? pane.id : adjacentPane.id
    const tab = { ...openWebPane, anchorPaneId: anchor, dock: 'panel' as const, openRevision: 0, unseen: false }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tab], activeTabs: { [anchor]: 'session' } }))
    vi.mocked(fetch).mockClear()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...tab, openRevision: 1, unseen: true }], activeTabs: { [anchor]: 'session' } }))
    if (focused) {
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tab.id}/active-tab`, expect.objectContaining({ method: 'POST' })))
      expect(screen.getByRole('tab', { name: /127.0.0.1:41300\/plan/ })).toHaveAttribute('aria-selected', 'true')
      await waitFor(() => expect(screen.queryByLabelText('New tab')).not.toBeInTheDocument())
      selectSession(anchor)
      act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...tab, openRevision: 2, unseen: true }], activeTabs: { [anchor]: 'session' } }))
      await waitFor(() => expect(screen.getByRole('tab', { name: /127.0.0.1:41300\/plan/ })).toHaveAttribute('aria-selected', 'true'))
      await waitFor(() => expect(screen.queryByLabelText('New tab')).not.toBeInTheDocument())
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/seen'))).toHaveLength(2)
    } else {
      expect(document.querySelector(`[data-pane-id="${anchor}"] .pane-tab-count`)).toHaveTextContent('1 new')
      expect(fetch).not.toHaveBeenCalledWith(`/api/web-panes/${tab.id}/active-tab`, expect.anything())
      expect(fetch).not.toHaveBeenCalledWith(`/api/web-panes/${tab.id}/seen`, expect.anything())
    }
  })

  it.each(['collapsed', 'maximized'] as const)('reveals a split simulator from a %s panel without selecting a panel tab or changing collapse state', async (state) => {
    await renderAppWithSnapshot()
    const simulator = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone 17 Pro', label: 'Review', task: 'Review', sessionName: 'work', ports: [], idle: false }
    const tile = { ...openWebPane, id: 'w-sim', dock: 'split' as const, url: '', content: { kind: 'simulator' as const, udid: simulator.udid } }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tile], activeTabs: { [pane.id]: 'session' } }))
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName: 'work',
      state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator,
    } }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Session' }))
    if (state === 'collapsed') fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    else fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    const live = await screen.findByTestId(`sim-${simulator.udid}`)
    await waitFor(() => expect(live).toHaveFocus())
    expect(live).toBeVisible()
    expect(live).toHaveAttribute('data-active', 'true')
    expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-panel-maximized')
    if (state === 'collapsed') expect(document.querySelector('.window-panel-layout')).toHaveClass('is-collapsed')
    else expect(document.querySelector('.window-panel-layout')).not.toHaveClass('is-collapsed')
    expect(fetch).not.toHaveBeenCalledWith(`/api/web-panes/${tile.id}/active-tab`, expect.anything())
  })
})


describe('narrow pane tabs', () => {
  const drawer = () => document.querySelector('.window-panel-layout') as HTMLElement
  const chip = (owner = pane) => screen.getByRole('button', { name: `Open tabs for ${owner.title}` })
  const closeButton = () => within(document.querySelector('.side-panel')!).getByRole('button', { name: 'Close tabs drawer' })

  beforeEach(() => { vi.stubGlobal('innerWidth', 800) })

  it('exempts the drawer trigger from the compact pane count hiding rule', async () => {
    await renderAppWithSnapshot()
    const css = readFileSync('src/styles.css', 'utf8')
    const compactRule = css.match(/@container\s*\(max-width:\s*360px\)\s*\{\s*([^{}]+)\{\s*display:\s*none;/)!
    expect(compactRule[1].trim()).toBe('.pane-tab-count:not(.pane-tab-button)')
    for (const owner of [pane, adjacentPane]) {
      expect(chip(owner)).toHaveClass('pane-tab-button')
      expect(chip(owner).matches(compactRule[1].trim())).toBe(false)
      expect(chip(owner)).toBeEnabled()
    }
    fireEvent.click(chip(adjacentPane))
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
  })

  it('opens and closes the drawer from an empty-only window and offers Add web tab', async () => {
    await renderAppWithSnapshot(snapshotWith([{ ...pane, empty: true }]))
    expect(screen.queryByTestId(`renderer-${pane.id}`)).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Empty pane' })).getByRole('button', { name: 'Open tabs for api' })).toBe(chip())
    expect(chip()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(chip())
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(chip()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Add web tab' }))
    expect(screen.getByRole('textbox', { name: 'Tab URL' })).toBeVisible()
    fireEvent.click(chip())
    expect(drawer()).not.toHaveClass('is-drawer-open')
    fireEvent.click(chip())
    fireEvent.click(closeButton())
    expect(chip()).toHaveFocus()
  })

  it('switches an open drawer to an empty pane through its uncovered trigger', async () => {
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, empty: true, active: false }]))
    const bounds = mockControlBounds()
    try {
      fireEvent.click(chip())
      await waitFor(() => expect(document.querySelector<HTMLElement>('.side-panel-scrim')!.style.clipPath).toContain('M500 20H540V40H500Z'))
      fireEvent.click(chip(adjacentPane))
      expect(drawer()).toHaveClass('is-drawer-open')
      expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
      expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
      fireEvent.click(chip(adjacentPane))
      expect(drawer()).not.toHaveClass('is-drawer-open')
    } finally { bounds.mockRestore() }
  })

  it('follows the CSS media query even when the rounded innerWidth disagrees', async () => {
    vi.stubGlobal('innerWidth', 841)
    const media = window.matchMedia(NARROW_PANEL_QUERY)
    Object.defineProperty(media, 'matches', { configurable: true, value: true })
    await renderAppWithSnapshot(snapshotWith([pane]))
    expect(drawer()).toHaveClass('is-narrow')
    expect(chip()).toBeInTheDocument()
    Object.defineProperty(media, 'matches', { configurable: true, value: false })
    act(() => media.dispatchEvent(new Event('change')))
    expect(drawer()).not.toHaveClass('is-narrow')
    expect(screen.queryByRole('button', { name: 'Open tabs for api' })).not.toBeInTheDocument()
  })

  it.each([false, true])('restores a maximized grid pane and visibly opens its drawer (previously opened=%s)', async (open) => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    if (open) {
      fireEvent.click(chip())
      fireEvent.click(closeButton())
    }
    fireEvent.click(screen.getByRole('button', { name: 'Maximize pane' }))
    expect(document.querySelector(`[data-pane-id="${pane.id}"]`)).toHaveClass('is-maximized')
    expect(document.querySelector('.side-panel')).toHaveAttribute('hidden')
    fireEvent.click(chip())
    expect(document.querySelector(`[data-pane-id="${pane.id}"]`)).not.toHaveClass('is-maximized')
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(document.querySelector('.side-panel')).not.toHaveAttribute('hidden')
    expect(screen.getByRole('tab', { name: 'Session' })).toBeVisible()
    fireEvent.click(closeButton())
    expect(drawer()).not.toHaveClass('is-drawer-open')
  })

  it.each(['dialog', 'page'] as const)('Escape on the %s closes an overlaid command palette while keeping the drawer open', async (target) => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    fireEvent.click(chip())
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    fireEvent.keyDown(target === 'dialog' ? palette.querySelector('input')! : window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument()
    expect(drawer()).toHaveClass('is-drawer-open')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(drawer()).not.toHaveClass('is-drawer-open')
  })

  function mockControlBounds() {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, x: left, y: top, width, height, toJSON: () => ({}) })
    return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('side-panel-scrim')) return rect(0, 100, 800, 300)
      if (this.dataset.panelChip === pane.id) return rect(100, 120, 40, 20)
      if (this.dataset.panelChip === adjacentPane.id) return rect(500, 120, 40, 20)
      if (this.classList.contains('pane-git-stats')) return rect(600, 300, 60, 20)
      return rect(0, 0, 0, 0)
    })
  }

  it('leaves the shown pane chip outside the scrim so clicking it again closes the drawer', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    const bounds = mockControlBounds()
    try {
      fireEvent.click(chip())
      expect(drawer()).toHaveClass('is-drawer-open')
      expect(document.querySelector<HTMLElement>('.side-panel-scrim')!.style.clipPath).toContain('M100 20H140V40H100Z')
      fireEvent.pointerDown(chip())
      fireEvent.focus(chip())
      fireEvent.click(chip())
      expect(drawer()).not.toHaveClass('is-drawer-open')
      expect(chip()).toHaveAttribute('aria-expanded', 'false')
      expect(chip()).toHaveFocus()
    } finally { bounds.mockRestore() }
  })

  it('leaves the other pane chip outside the scrim so it switches focus and tabs while keeping the drawer open', async () => {
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, active: false }]))
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const first = { ...openWebPane, dock: 'panel' as const, unseen: false, activeTab: true }
    const second = { ...first, id: 'w-other', anchorPaneId: adjacentPane.id, url: 'http://localhost/two' }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [first, second], activeTabs: { [pane.id]: first.id, [adjacentPane.id]: second.id } }))
    const bounds = mockControlBounds()
    try {
      fireEvent.click(chip())
      const path = document.querySelector<HTMLElement>('.side-panel-scrim')!.style.clipPath
      expect(path).toContain('M100 20H140V40H100Z')
      expect(path).toContain('M500 20H540V40H500Z')
      fireEvent.pointerDown(chip(adjacentPane))
      fireEvent.focus(chip(adjacentPane))
      fireEvent.click(chip(adjacentPane))
      expect(drawer()).toHaveClass('is-drawer-open')
      expect(chip(adjacentPane)).toHaveAttribute('aria-expanded', 'true')
      expect(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`)).toHaveClass('is-focused')
      expect(screen.getByRole('tab', { name: /localhost\/two/ })).toHaveAttribute('aria-selected', 'true')
      expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
    } finally { bounds.mockRestore() }
  })

  it('shows a button on every pane and preserves each pane active tab across toggle and pane switches', async () => {
    await renderAppWithSnapshot(snapshotWith([pane, { ...adjacentPane, active: false }]))
    expect(chip()).toHaveAttribute('aria-expanded', 'false')
    expect(chip(adjacentPane)).toHaveAttribute('aria-expanded', 'false')
    expect(chip()).not.toHaveTextContent(/\d/)
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const tab = { ...openWebPane, dock: 'panel' as const, unseen: false, activeTab: true }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tab], activeTabs: { [pane.id]: tab.id } }))
    fireEvent.click(chip())
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(screen.getByRole('tab', { name: /127.0.0.1:41300/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.pointerDown(chip(adjacentPane))
    fireEvent.focus(chip(adjacentPane))
    fireEvent.click(chip(adjacentPane))
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(chip(adjacentPane))
    expect(drawer()).not.toHaveClass('is-drawer-open')
    fireEvent.click(chip())
    expect(screen.getByRole('tab', { name: /127.0.0.1:41300/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps agent opens and URL reuses closed, badges unseen and makes Chromium visible only on user open', async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = []
      readyState = 0
      close = vi.fn()
      constructor(readonly url: string) { FakeWebSocket.instances.push(this) }
      addEventListener() {}
      removeEventListener() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await renderAppWithSnapshot(snapshotWith([pane]))
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    const tab = { ...openWebPane, dock: 'panel' as const, engine: 'chromium' as const, unseen: true, openRevision: 0 }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tab], activeTabs: { [pane.id]: 'session' } }))
    expect(drawer()).not.toHaveClass('is-drawer-open')
    expect(chip()).toHaveClass('has-new')
    expect(within(chip()).getByLabelText('New updates')).toBeInTheDocument()
    const chromium = screen.getByLabelText(`Chromium tile: ${tab.url}`)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(chromium.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [{ ...tab, openRevision: 1 }], activeTabs: { [pane.id]: 'session' } }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tab.id}/active-tab`, expect.anything()))
    expect(drawer()).not.toHaveClass('is-drawer-open')
    expect(fetch).not.toHaveBeenCalledWith(`/api/web-panes/${tab.id}/seen`, expect.anything())
    fireEvent.click(chip())
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(chromium.closest('[role="tabpanel"]')).not.toHaveAttribute('hidden')
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/web-panes/${tab.id}/seen`, expect.anything()))
    fireEvent.click(closeButton())
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledOnce()
    expect(chromium.closest('[role="tabpanel"]')).toHaveAttribute('hidden')
    expect(chip()).toHaveFocus()
  })

  it('badges session warnings on a pane without web tabs without opening the drawer', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    act(() => daemonMessage?.({ type: 'agent_resume', resume: {
      targetId: pane.targetId, paneId: pane.id, provider: 'claude', command: 'claude --resume test',
      state: 'failed', error: 'Resume failed', updatedAt: Date.now(),
    } }))
    await waitFor(() => expect(within(chip()).getByLabelText('Session resume failed')).toHaveClass('is-warning'))
    expect(chip()).toHaveClass('has-new')
    expect(drawer()).not.toHaveClass('is-drawer-open')
  })

  it('keeps native tabs mounted and passes visible:false while the drawer is closed', async () => {
    const spy = vi.spyOn(nativeWebViewBridge, 'getNativeWebViewBridge').mockReturnValue({ connect: async () => ({ available: true }) } as unknown as nativeWebViewBridge.NativeWebViewBridge)
    try {
      await renderAppWithSnapshot(snapshotWith([pane]))
      const tab = { ...openWebPane, dock: 'panel' as const, url: 'https://example.com/', unseen: true }
      act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tab], activeTabs: { [pane.id]: tab.id } }))
      const native = await screen.findByTestId(`native-web-${tab.id}`)
      expect(native).toHaveAttribute('data-visible', 'false')
      fireEvent.click(chip())
      expect(native).toHaveAttribute('data-visible', 'true')
      fireEvent.click(closeButton())
      expect(screen.getByTestId(`native-web-${tab.id}`)).toBe(native)
      expect(native).toHaveAttribute('data-visible', 'false')
    } finally { spy.mockRestore() }
  })

  it('opens Changes from the footer on the owning pane', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const value = String(input).includes('/api/git/summary')
        ? { isRepo: true, target: 'main', additions: 3, deletions: 1, files: [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1, binary: false }] } : String(input).includes('/api/git/file-diff') ? { file: 'a.ts', diff: '' } : {}
      return new Response(JSON.stringify(value), { status: 200 })
    })
    await renderAppWithSnapshot()
    const bounds = mockControlBounds()
    try {
      fireEvent.click(chip())
      expect(document.querySelector<HTMLElement>('.side-panel-scrim')!.style.clipPath).toContain('M600 200H660V220H600Z')
      fireEvent.click(within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`)!).getByRole('button', { name: /Git changes/ }))
      expect(drawer()).toHaveClass('is-drawer-open')
      expect(await screen.findByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
      expect(document.querySelector('.side-panel-owner')).toHaveTextContent(adjacentPane.id)
      fireEvent.click(screen.getByRole('tab', { name: 'Session' }))
      const changes = within(document.querySelector(`[data-pane-id="${adjacentPane.id}"]`)!).getByRole('button', { name: /Git changes/ })
      fireEvent.pointerDown(changes)
      fireEvent.click(changes)
      expect(drawer()).toHaveClass('is-drawer-open')
      expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute('aria-selected', 'true')
    } finally { bounds.mockRestore() }
  })

  it('opens the simulator from Show beside pane and hides it again on close', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    const simulator = { udid: '11111111-1111-1111-1111-111111111111', originalName: 'iPhone 17 Pro', label: 'Review', task: 'Review', sessionName: 'work', ports: [], idle: false }
    const tile = { ...openWebPane, id: 'w-sim', dock: 'panel' as const, url: '', content: { kind: 'simulator' as const, udid: simulator.udid } }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [tile], activeTabs: { [pane.id]: 'session' } }))
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: pane.id, targetId: pane.targetId, sessionId: pane.sessionId, sessionName: 'work',
      state: 'unknown', headline: 'Pane worklog', headlineSource: 'hook', updates: [], updatedAt: 0, simulator,
    } }))
    const live = screen.getByTestId(`sim-${simulator.udid}`)
    expect(live).toHaveAttribute('data-visible', 'false')
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'Show beside pane', hidden: true }))
    await waitFor(() => expect(live).toHaveFocus())
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(live).toHaveAttribute('data-visible', 'true')
    fireEvent.click(closeButton())
    expect(live).toHaveAttribute('data-visible', 'false')
    expect(live).toHaveAttribute('data-active', 'false')
  })

  it('does not remount or change terminal measurements on toggle or breakpoint crossing, and restores wide collapse state', async () => {
    localStorage.setItem('commando.side-panel.collapsed.@2', 'true')
    await renderAppWithSnapshot(snapshotWith([pane]))
    const renderer = screen.getByTestId(`renderer-${pane.id}`)
    const measurementKey = renderer.getAttribute('data-measurement-key')
    appMocks.send.mockClear()
    fireEvent.click(chip())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(chip()).toHaveFocus()
    expect(drawer()).not.toHaveClass('is-drawer-open')
    fireEvent.click(chip())
    vi.stubGlobal('innerWidth', 1440)
    act(() => window.matchMedia(NARROW_PANEL_QUERY).dispatchEvent(new Event('change')))
    fireEvent.resize(window)
    expect(drawer()).not.toHaveClass('is-narrow')
    expect(drawer()).toHaveClass('is-collapsed')
    expect(screen.queryByRole('button', { name: 'Open tabs for api' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand side panel' })).toBeInTheDocument()
    vi.stubGlobal('innerWidth', 840)
    act(() => window.matchMedia(NARROW_PANEL_QUERY).dispatchEvent(new Event('change')))
    fireEvent.resize(window)
    expect(drawer()).toHaveClass('is-narrow', 'is-collapsed')
    expect(drawer()).not.toHaveClass('is-drawer-open')
    expect(screen.getByTestId(`renderer-${pane.id}`)).toBe(renderer)
    expect(renderer).toHaveAttribute('data-measurement-key', measurementKey)
    expect(renderer).toHaveAttribute('data-resize-owner', 'true')
    expect(appMocks.send.mock.calls.filter(([message]) => ['apply_window_layout', 'set_window_layout', 'resize'].includes(message.type))).toEqual([])
  })

  it('restores a maximized tab to the remembered drawer height and keeps split tiles in the grid', async () => {
    localStorage.setItem('commando.side-panel.height.@2', '73')
    await renderAppWithSnapshot(snapshotWith([pane]))
    fireEvent.click(chip())
    const height = drawer().style.getPropertyValue('--side-panel-height')
    fireEvent.click(screen.getByRole('button', { name: 'Maximize panel tab' }))
    expect(drawer()).toHaveClass('is-panel-maximized')
    expect(document.querySelector('.window-terminal-grid')).toHaveAttribute('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Restore panel tab' }))
    expect(drawer()).toHaveClass('is-drawer-open')
    expect(drawer().style.getPropertyValue('--side-panel-height')).toBe(height)
    const split = { ...openWebPane, dock: 'split' as const }
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [split] }))
    expect(document.querySelector(`[data-web-pane-id="${split.id}"]`)?.closest('.window-terminal-grid')).toBeInTheDocument()
  })
})
