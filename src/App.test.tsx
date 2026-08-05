// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandoSnapshot, ServerMessage, TmuxPane } from '../shared/protocol'
import { App, AuthGate, PaneActionErrorFeedback, TerminalPaneCard } from './App'
import { getAuthBootstrap, getAuthUser } from './authClient'
import type { ConnectionState } from './useDaemon'

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
  }: {
    paneId: string
    nativeRetryKey?: number
    useXtermFallback?: boolean
    onRendererChange: (renderer: 'native' | 'xterm') => void
    onSelectionCopied: () => void
    registerFocusable: (paneId: string, node: HTMLElement | null) => void
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
      >
        <button type="button" onClick={onSelectionCopied}>Simulate terminal selection copy</button>
        <button type="button" onClick={() => setFailed(true)}>Simulate native failure {paneId}</button>
      </div>
    )
  },
}))
vi.mock('./ResizablePaneLayout', () => ({
  ResizablePaneLayout: ({ panes }: { panes: ReadonlyMap<string, React.ReactNode> }) => (
    <div>{[...panes.values()]}</div>
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
  window.sessionStorage.clear()
  window.localStorage.clear()
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
