// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import type { TmuxCreatedTarget } from '../shared/tmux-create'
import { SessionTree } from './SessionTree'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'

const sessionApi = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  deleteWindow: vi.fn(),
}))

vi.mock('./sessionManagementApi', () => ({ createSessionManagementApi: () => sessionApi }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  vi.clearAllMocks()
  sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
  sessionApi.savePreferences.mockImplementation(async (preferences) => preferences)
  sessionApi.deleteWindow.mockResolvedValue(undefined)
})

function pane(id: string, index: number, title: string): TmuxPane {
  return {
    id,
    targetId: `550e8400-e29b-41d4-a716-${id.slice(1).padStart(12, '0')}`,
    index,
    title,
    windowId: '@1',
    sessionId: '$1',
    command: 'zsh',
    path: '/workspace',
    active: index === 0,
    dead: false,
    width: 80,
    height: 24,
    cursorX: 0,
    cursorY: 0,
    alternateSavedX: 0,
    alternateSavedY: 0,
    alternateOn: false,
    cursorVisible: true,
    cursorShape: 'default',
    cursorBlinking: false,
    scrollRegionUpper: 0,
    scrollRegionLower: 23,
    wrapFlag: false,
    originFlag: false,
    insertFlag: false,
    keypadFlag: false,
    keypadCursorFlag: false,
    mouseAnyFlag: false,
    mouseSgrFlag: false,
    paneTabs: [],
  }
}

function agentStatus(paneId: string, provider: AgentStatus['provider'], status: AgentStatus['status']): AgentStatus {
  return {
    paneId,
    provider,
    status,
    summary: '',
    source: 'hook',
    confidence: 'high',
    reason: '',
    updatedAt: 1,
  }
}

describe('SessionTree', () => {
  it('opens the first nine sessions by their session-tree order', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: ['$3', '$1', '$stale'] },
        { id: 'vivi', name: 'VIVI', sessionIds: ['$4'] },
      ],
      ungroupedSessionIds: ['$2'],
    })
    const sessions = Array.from({ length: 10 }, (_, index) => ({
      id: `$${index + 1}`,
      name: `session-${index + 1}`,
      attached: false,
      activeWindowId: null,
      windowIds: [],
    }))
    const onSelectSession = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={sessions}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={onSelectSession}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    await screen.findByText('GIZMO')
    await waitFor(() => expect(screen.getByText('session-3')).toBeInTheDocument())
    for (const key of ['1', '2', '3', '4', '5', '9']) {
      fireEvent.keyDown(window, { key, metaKey: true })
    }

    expect(onSelectSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      '$3',
      '$1',
      '$4',
      '$2',
      '$5',
      '$9',
    ])

    onSelectSession.mockClear()
    fireEvent(window, new CustomEvent(NATIVE_TERMINAL_SHORTCUT_EVENT, {
      detail: { key: '2', metaKey: true },
    }))
    expect(onSelectSession).toHaveBeenCalledWith('$1')
  })

  it('ignores session numbers outside Cmd+1 through Cmd+9', () => {
    const onSelectSession = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: null, windowIds: [] }]}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={onSelectSession}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    fireEvent.keyDown(window, { key: '1' })
    fireEvent.keyDown(window, { key: '0', metaKey: true })
    fireEvent.keyDown(window, { key: '1', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: '2', metaKey: true })

    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it('moves named groups in their persisted display order', async () => {
    const onPreferencesChanged = vi.fn()
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
        { id: 'gizmo', name: 'GIZMO', sessionIds: [] },
      ],
      ungroupedSessionIds: [],
    })
    render(
      <SessionTree
        token="token"
        sessions={[]}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={onPreferencesChanged}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Move GIZMO up' }))

    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledWith({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: [] },
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
      ],
      ungroupedSessionIds: [],
    }))
    expect(onPreferencesChanged).toHaveBeenCalledWith({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: [] },
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
      ],
      ungroupedSessionIds: [],
    })
  })

  it('reorders sessions within their current group by drag and drop', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2', '$3'] }],
      ungroupedSessionIds: [],
    })
    render(
      <SessionTree
        token="token"
        sessions={[
          { id: '$1', name: 'first', attached: false, activeWindowId: null, windowIds: [] },
          { id: '$2', name: 'second', attached: false, activeWindowId: null, windowIds: [] },
          { id: '$3', name: 'third', attached: false, activeWindowId: null, windowIds: [] },
        ]}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    await screen.findByText('GIZMO')
    const third = screen.getByText('third').closest('article')
    const first = screen.getByText('first').closest('article')
    expect(third).not.toBeNull()
    expect(first).not.toBeNull()

    fireEvent.dragStart(third!)
    await waitFor(() => expect(third).toHaveClass('dragging'))
    fireEvent.dragOver(first!)
    fireEvent.drop(first!)

    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledTimes(1))
    expect(sessionApi.savePreferences).toHaveBeenCalledWith({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$3', '$1', '$2'] }],
      ungroupedSessionIds: [],
    })
  })

  it('collapses and expands every session group from its title', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] }],
      ungroupedSessionIds: ['$2'],
    })
    render(
      <SessionTree
        token="token"
        sessions={[
          { id: '$1', name: 'gizmo-work', attached: true, activeWindowId: null, windowIds: [] },
          { id: '$2', name: 'loose-work', attached: false, activeWindowId: null, windowIds: [] },
        ]}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const gizmoToggle = await screen.findByRole('button', { name: 'Collapse GIZMO' })
    const ungroupedToggle = screen.getByRole('button', { name: 'Collapse Ungrouped' })
    expect(gizmoToggle).toHaveAttribute('aria-expanded', 'true')
    expect(ungroupedToggle).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(gizmoToggle)
    expect(gizmoToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('gizmo-work')).not.toBeVisible()
    expect(screen.getByText('loose-work')).toBeVisible()

    fireEvent.click(gizmoToggle)
    fireEvent.click(ungroupedToggle)
    expect(screen.getByText('gizmo-work')).toBeVisible()
    expect(screen.getByText('loose-work')).not.toBeVisible()
  })

  it('creates a session in a group using a directory from that group', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] }],
      ungroupedSessionIds: [],
    })
    const created: TmuxCreatedTarget = {
      kind: 'session',
      sessionId: '$2',
      sessionName: 'new-gizmo-work',
      windowId: '@2',
      windowIndex: 0,
      windowName: 'shell',
      paneId: '%2',
      paneIndex: 0,
      panePath: '/Users/dev/gizmo',
    }
    const onCreateSession = vi.fn(async () => created)
    const onCreated = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'gizmo-work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'shell', active: true, layout: 'layout', paneIds: ['%1'] }]}
        panes={[{ ...pane('%1', 0, 'Gizmo shell'), path: '/Users/dev/gizmo' }]}
        displayedPaneIds={['%1']}
        statuses={{}}
        selectedSessionId="$1"
        focusedPaneId="%1"
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
        creation={{
          onCreateSession,
          onCreateWindow: vi.fn(),
          onCreatePane: vi.fn(),
          onCreated,
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in GIZMO' }))
    expect(await screen.findByText('New session in GIZMO')).toBeVisible()
    expect(screen.getByRole('combobox', { name: /Working directory/ })).toHaveValue('/Users/dev/gizmo')
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'new-gizmo-work' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))

    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledWith({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2'] }],
      ungroupedSessionIds: [],
    }))
    expect(onCreateSession).toHaveBeenCalledWith({
      name: 'new-gizmo-work',
      windowName: '',
      cwd: '/Users/dev/gizmo',
    })
    expect(onCreated).toHaveBeenCalledWith(created)
  })

  it('preserves group changes made while session creation is pending', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] },
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
      ],
      ungroupedSessionIds: [],
    })
    let resolveCreate: ((created: TmuxCreatedTarget) => void) | undefined
    const onCreateSession = vi.fn(() => new Promise<TmuxCreatedTarget>((resolve) => {
      resolveCreate = resolve
    }))
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'gizmo-work', attached: true, activeWindowId: null, windowIds: [] }]}
        windows={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId="$1"
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
        creation={{
          onCreateSession,
          onCreateWindow: vi.fn(),
          onCreatePane: vi.fn(),
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in GIZMO' }))
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'pending-session' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move GIZMO down' }))
    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledTimes(1))

    resolveCreate?.({
      kind: 'session',
      sessionId: '$2',
      sessionName: 'pending-session',
      windowId: '@2',
      windowIndex: 0,
      windowName: 'shell',
      paneId: '%2',
      paneIndex: 0,
      panePath: '/workspace',
    })

    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledTimes(2))
    expect(sessionApi.savePreferences).toHaveBeenLastCalledWith({
      version: 1,
      groups: [
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
        { id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2'] },
      ],
      ungroupedSessionIds: [],
    })
  })

  it('lists panes in their displayed workspace order', () => {
    const panes = [
      pane('%1', 0, 'First tmux pane'),
      pane('%2', 1, 'Second tmux pane'),
      pane('%3', 2, 'Third tmux pane'),
    ]
    const onOpenPaneMaximized = vi.fn()
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'zsh', active: true, layout: 'dbde,80x24,0,0,1', paneIds: panes.map(({ id }) => id) }]}
        panes={panes}
        displayedPaneIds={['%3', '%1', '%2']}
        statuses={{}}
        selectedSessionId="$1"
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={onOpenPaneMaximized}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const labels = [...container.querySelectorAll('.managed-pane-main')]
      .map((button) => button.textContent)
    expect(labels).toEqual(['Third tmux pane', 'First tmux pane', 'Second tmux pane'])

    fireEvent.click(screen.getByRole('button', { name: 'Open Third tmux pane maximized' }))
    expect(onOpenPaneMaximized).toHaveBeenCalledWith('%3')
  })

  it('shows ordered accessible pane statuses on a collapsed session', () => {
    const panes = [
      pane('%1', 0, 'Claude pane'),
      pane('%2', 1, 'No agent'),
      pane('%3', 2, 'Codex pane'),
    ]
    const onSelectPane = vi.fn()
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'zsh', active: true, layout: 'dbde,80x24,0,0,1', paneIds: panes.map(({ id }) => id) }]}
        panes={panes}
        displayedPaneIds={['%3', '%2', '%1']}
        statuses={{
          '%1': agentStatus('%1', 'claude', 'working'),
          '%3': agentStatus('%3', 'codex', 'needs_input'),
        }}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={onSelectPane}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const dots = [...container.querySelectorAll('.session-status-dot')]
    expect(dots).toHaveLength(2)
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Codex: needs input - Codex pane',
      'Claude: working - Claude pane',
    ])
    expect(dots.map((dot) => dot.getAttribute('title'))).toEqual([
      'Codex: needs input - Codex pane',
      'Claude: working - Claude pane',
    ])
    expect(dots[0]).toHaveClass('needs_input')
    expect(dots[1]).toHaveClass('working')
    fireEvent.click(dots[0])
    expect(onSelectPane).toHaveBeenCalledWith('%3')
    expect(container.querySelector('.managed-window-tree')).not.toBeInTheDocument()
    expect(container.querySelector('.live-dot')).not.toBeInTheDocument()
  })

  it('mirrors durable pane marks and activity counts in session and pane rows', () => {
    const panes = [pane('%1', 0, 'Release pane'), pane('%2', 1, 'API pane')]
    const onSelectPane = vi.fn()
    const marks = {
      [panes[0].targetId]: { targetId: panes[0].targetId, label: 'Waiting for PR', tone: 'amber' as const, markedAt: 10, activityCount: 0 },
      [panes[1].targetId]: { targetId: panes[1].targetId, label: 'Blocked', tone: 'red' as const, markedAt: 20, activityCount: 3, lastActivityAt: 30 },
    }
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'zsh', active: true, layout: 'dbde,80x24,0,0,1', paneIds: panes.map(({ id }) => id) }]}
        panes={panes}
        displayedPaneIds={['%2', '%1']}
        statuses={{}}
        marks={marks}
        selectedSessionId="$1"
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={onSelectPane}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const dots = [...container.querySelectorAll<HTMLButtonElement>('.session-mark-dot')]
    expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Blocked, 3 activities since mark - API pane',
      'Waiting for PR - Release pane',
    ])
    expect(dots[0]).toHaveClass('tone-red', 'has-activity')
    expect(dots[0]).toHaveTextContent('3')
    expect(container.querySelectorAll('.mini-pane-mark')).toHaveLength(2)
    fireEvent.click(dots[0])
    expect(onSelectPane).toHaveBeenCalledWith('%2')
  })

  it('does not show attachment or placeholder dots without pane statuses', () => {
    const panes = [pane('%1', 0, 'No agent')]
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'attached', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'zsh', active: true, layout: 'dbde,80x24,0,0,1', paneIds: ['%1'] }]}
        panes={panes}
        displayedPaneIds={['%1']}
        statuses={{}}
        selectedSessionId={null}
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    expect(container.querySelector('.session-status-cluster')).not.toBeInTheDocument()
    expect(container.querySelector('.session-status-dot')).not.toBeInTheDocument()
    expect(container.querySelector('.live-dot')).not.toBeInTheDocument()
  })

  it('confirms and closes a tmux window', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onSessionsChanged = vi.fn()
    const onWindowDeleting = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        windows={[{ id: '@1', index: 0, sessionId: '$1', name: 'zsh', active: true, layout: 'dbde,80x24,0,0,1', paneIds: [] }]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId="$1"
        focusedPaneId={null}
        onSelectSession={vi.fn()}
        onSelectWindow={vi.fn()}
        onSelectPane={vi.fn()}
        onOpenPaneMaximized={vi.fn()}
        onWindowDeleting={onWindowDeleting}
        onSessionsChanged={onSessionsChanged}
        onPreferencesChanged={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close window zsh' }))

    await waitFor(() => expect(sessionApi.deleteWindow).toHaveBeenCalledWith('@1'))
    expect(onWindowDeleting).toHaveBeenCalledWith('@1')
    expect(onSessionsChanged).toHaveBeenCalled()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('last window'))
  })
})
