// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, LayoutSpec, ServerMessage, SessionBrief, TmuxPane } from '../shared/protocol'
import { App, AuthGate, PANE_JUMP_HIGHLIGHT_MS, PaneActionErrorFeedback, TerminalPaneCard } from './App'
import { getAuthBootstrap, getAuthUser } from './authClient'
import type { ConnectionState } from './useDaemon'
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
  getNativeTerminalBridge: () => ({ connect: appMocks.nativeConnect }),
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
vi.mock('./NativeWebViewTile', () => ({ NativeWebViewTile: () => null }))
vi.mock('./PaneGitStats', () => ({ PaneGitStats: () => null }))
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
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
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
  await screen.findByTestId(`renderer-${snapshot.panes[0]!.id}`)
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

describe('session update briefs', () => {
  it('keeps worklogs and personal notes available before any hook brief arrives', async () => {
    await renderAppWithSnapshot()
    fireEvent.click(await screen.findByRole('button', { name: 'Expand worklog for api' }))
    expect(screen.getByLabelText('Worklog for api')).toHaveTextContent('No agent hook data received')
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for api' }), { target: { value: 'Waiting for agent metadata' } })
    expect(screen.getByRole('textbox', { name: 'Note for api' })).toHaveValue('Waiting for agent metadata')
    act(() => daemonMessage?.({ type: 'session_brief', brief: {
      paneId: '%12', targetId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', sessionId: '$3', sessionName: 'work',
      state: 'done', headline: 'An old owner', headlineSource: 'agent', updates: [], updatedAt: 1,
    } }))
    expect(screen.getByLabelText('Worklog for api')).not.toHaveTextContent('An old owner')
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

    expect(await screen.findByLabelText('Minimized worklog for api')).toBeInTheDocument()
    expect(screen.getByLabelText('Minimized worklog for worker')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for api' }))
    const apiWorklog = screen.getByLabelText('Worklog for api')
    expect(apiWorklog).toHaveTextContent('API routes are ready')
    expect(apiWorklog).toHaveTextContent('Review API output')
    expect(apiWorklog).not.toHaveTextContent('Worker tests passed')

    fireEvent.click(screen.getByRole('button', { name: 'Expand worklog for worker' }))
    const workerWorklog = screen.getByLabelText('Worklog for worker')
    expect(workerWorklog).toHaveTextContent('Worker tests passed')
    expect(workerWorklog).not.toHaveTextContent('API routes are ready')

    fireEvent.click(screen.getByRole('button', { name: 'Minimize worklog for api' }))
    expect(screen.getByLabelText('Minimized worklog for api')).toBeInTheDocument()
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

  it('opens the marked pane diff at the PR base and head OIDs', async () => {
    const targetId = adjacentPane.targetId
    const baseRefOid = '1111111111111111111111111111111111111111'
    const headRefOid = '2222222222222222222222222222222222222222'
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
            number: 12, title: 'feat: pane diff', url: 'https://github.com/acme/widgets/pull/12',
            state: 'open', isDraft: false, author: 'leo', bodyExcerpt: '', additions: 379, deletions: 46,
            changedFiles: 1, commitCount: 1, unresolvedThreads: 0, threadsTruncated: false,
            reviewDecision: null, reviews: [], requestedReviewers: [], conflicting: false, checks: null,
            createdAt: '', updatedAt: new Date().toISOString(), headRefName: 'feat/pane-diff',
            baseRefName: 'main', headRefOid, baseRefOid, viewerIsAuthor: true, viewerReviewRequested: false,
            commandoMarker: { version: 1, targetId, relation: 'created' },
          }],
        } })
      }
      if (url.includes('/api/git/summary')) {
        return json({ isRepo: true, root: adjacentPane.path, branch: 'feat/pane-diff', files: [] })
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    })

    await renderAppWithSnapshot()
    fireEvent.click(screen.getByRole('tab', { name: 'PRs' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open diff for PR #12: +379 -46' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByTitle(headRefOid)).toHaveTextContent('feat/pane-diff')
    expect(screen.getByTitle(baseRefOid)).toHaveTextContent('main')
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/git/summary?paneId=%2513&target=${baseRefOid}&head=${headRefOid}`,
      expect.any(Object),
    ))

    act(() => daemonMessage?.({ type: 'snapshot', snapshot: snapshotWith([pane]) }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
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

describe('web pane tiles', () => {
  it('does not treat a terminal sharing its layout with a web tile as solo', async () => {
    await renderAppWithSnapshot(snapshotWith([pane]))
    const terminal = document.querySelector('[data-pane-id="%12"]')
    expect(terminal).toHaveClass('is-solo')

    act(() => daemonMessage?.({
      type: 'web_panes',
      webPanes: [{ ...openWebPane, placement: 'below' }],
    }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')

    expect(terminal).not.toHaveClass('is-solo')
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
        expect(init?.method).toBe('DELETE')
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
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))
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

  it('never leaks the web tile id into daemon protocol messages while maximized', async () => {
    // Arrange: workspace with terminal panes %12, %13 and one web tile.
    await renderAppWithSnapshot()
    act(() => daemonMessage?.({ type: 'web_panes', webPanes: [openWebPane] }))
    await screen.findByTitle('Web pane: 127.0.0.1:41300')
    appMocks.send.mockClear()

    const assertNoWebIdLeaked = () => {
      for (const call of appMocks.send.mock.calls) {
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
