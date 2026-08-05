// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, ServerMessage, TmuxPane } from '../shared/protocol'
import { App, AuthGate, PaneActionErrorFeedback, TerminalPaneCard } from './App'
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
      return json({ prefs: { version: 1, pinnedRepos: [], lastRepo: 'acme/widgets', lastFilter: 'open', lastScope: 'mine' } })
    }
    if (url.includes('/api/prs/repos')) return json({ repos: [{ nameWithOwner: 'acme/widgets', pinned: true }] })
    if (url.includes('/api/prs')) {
      return json({ list: { repo: 'acme/widgets', filter: 'open', viewer: 'leo', totalCount: 0, pullRequests: [], truncated: false, fetchedAt: 0 } })
    }
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
  processId: 1_300,
  index: 2,
  title: 'worker',
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

async function renderAppWithSnapshot(snapshot = snapshotWith([pane, adjacentPane])) {
  window.sessionStorage.setItem('commando.session-token', 'test-token')
  const view = render(<App />)
  act(() => daemonMessage?.({ type: 'snapshot', snapshot }))
  await screen.findByTestId(`renderer-${snapshot.panes[0]!.id}`)
  return view
}

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
  preset: 'equal-grid' as const,
  maximized: false,
  focused: false,
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
    branches: vi.fn().mockResolvedValue({ isRepo: false }),
  },
  onOpenPath: vi.fn().mockResolvedValue(undefined),
  onFocus: vi.fn(),
  onOpenMenu: vi.fn(),
  onRename: vi.fn().mockResolvedValue(undefined),
  onRenameFinished: vi.fn(),
  onMove: vi.fn(),
  onMaximize: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onDragOver: vi.fn(),
  onDrop: vi.fn(),
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
