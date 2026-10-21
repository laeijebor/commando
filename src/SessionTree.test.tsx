// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatus, PaneRepo, TmuxPane } from '../shared/protocol'
import type { TmuxCreatedTarget } from '../shared/tmux-create'
import { deriveSessionIdentity } from '../shared/session-identity'
import { SessionTree, type SessionActions } from './SessionTree'
import { NATIVE_TERMINAL_SHORTCUT_EVENT } from './nativeTerminalBridge'
import type { PrsApiClient, PanePrSummary } from './prsApi'

const sessionApi = vi.hoisted(() => ({
  loadPreferences: vi.fn(),
  savePreferences: vi.fn(),
  renameSession: vi.fn(),
  changeIdentity: vi.fn(),
  deleteSession: vi.fn(),
  previewWorktreeDeletion: vi.fn(),
  listArchives: vi.fn(),
  archiveSession: vi.fn(),
  restoreSession: vi.fn(),
}))

vi.mock('./sessionManagementApi', () => ({ createSessionManagementApi: () => sessionApi }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ command: '' })))
  vi.clearAllMocks()
  sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [], groupingMode: 'manual' })
  sessionApi.savePreferences.mockImplementation(async (preferences) => preferences)
  sessionApi.previewWorktreeDeletion.mockResolvedValue({ auxiliarySessions: [] })
  sessionApi.listArchives.mockResolvedValue([])
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
  it('shows attached IDEs as a glyph on session rows', async () => {
    const onOpenIde = vi.fn()
    render(<SessionTree
      token="token" sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: null, windowIds: [] }, { id: '$2', name: 'other', attached: false, activeWindowId: null, windowIds: [] }]}
      panes={[]} displayedPaneIds={[]} statuses={{}} selectedSessionId={null}
      onSelectSession={vi.fn()} onSelectPane={vi.fn()}
      onSessionsChanged={vi.fn()} onPreferencesChanged={vi.fn()} onOpenIde={onOpenIde}
      ides={[{ id: 'ide-1111111111111111', sessionIds: ['$1'], workspacePath: '/worktree', state: 'ready', generation: 1, url: '/ide/ide-1111111111111111/' }]}
    />)
    const badge = await screen.findByRole('button', { name: 'Open attached IDE for work' })
    expect(badge).toHaveClass('session-ide-glyph', 'state-ready')
    expect(screen.queryByRole('button', { name: 'Open attached IDE for other' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open attached IDE for work' }))
    expect(onOpenIde).toHaveBeenCalledWith('$1')
    fireEvent.click(screen.getByRole('button', { name: 'Actions for other' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open IDE' }))
    expect(onOpenIde).toHaveBeenLastCalledWith('$2')
  })
  it('keeps the selected session to a single row with a muted PR glyph', async () => {
    const open: PanePrSummary = {
      repo: 'acme/app', number: 12, title: 'Ship the feature', url: 'https://github.com/acme/app/pull/12',
      state: 'open', isDraft: false, createdAt: '', updatedAt: '', additions: 2, deletions: 1,
      checks: { state: 'fail', runs: [], failed: 1, pending: 0, total: 1, truncated: false }, conflicting: false, unresolvedThreads: 0, threadsTruncated: false, reviewDecision: null,
    }
    const prsApi = { pane: vi.fn(async () => ({ targetId: 'target', pullRequests: [open], totalCount: 1, truncated: false, fetchedAt: 1 })) } as unknown as PrsApiClient
    const { container } = render(<SessionTree
      token="token" sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
      panes={[pane('%1', 0, 'Agent pane')]} displayedPaneIds={['%1']} statuses={{}}
      selectedSessionId="$1" onSelectSession={vi.fn()} onSelectPane={vi.fn()}
      onSessionsChanged={vi.fn()} onPreferencesChanged={vi.fn()} prsApi={prsApi} connected
    />)
    const glyph = await screen.findByRole('img', { name: 'PR #12 in work: Failed checks' })
    expect(glyph).toHaveClass('tone-red')
    expect(glyph).toHaveTextContent('')
    expect(screen.getByRole('button', { name: 'work' })).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('region', { name: 'Open pull requests in work' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.managed-session-row')).toHaveLength(1)
  })

  it('opens the first nine sessions by their session-tree order', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groupingMode: 'manual',
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
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={onSelectSession}
        onSelectPane={vi.fn()}
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
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={onSelectSession}
        onSelectPane={vi.fn()}
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
      groupingMode: 'manual',
    })
    render(
      <SessionTree
        token="token"
        sessions={[]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
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
      groupingMode: 'manual',
    }))
    expect(onPreferencesChanged).toHaveBeenCalledWith({
      version: 1,
      groups: [
        { id: 'gizmo', name: 'GIZMO', sessionIds: [] },
        { id: 'vivi', name: 'VIVI', sessionIds: [] },
      ],
      ungroupedSessionIds: [],
      groupingMode: 'manual',
    })
  })

  it('reorders sessions within their current group by drag and drop', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2', '$3'] }],
      ungroupedSessionIds: [],
      groupingMode: 'manual',
    })
    render(
      <SessionTree
        token="token"
        sessions={[
          { id: '$1', name: 'first', attached: false, activeWindowId: null, windowIds: [] },
          { id: '$2', name: 'second', attached: false, activeWindowId: null, windowIds: [] },
          { id: '$3', name: 'third', attached: false, activeWindowId: null, windowIds: [] },
        ]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
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
      groupingMode: 'manual',
    })
  })

  it('collapses and expands every session group from its title', async () => {
    sessionApi.loadPreferences.mockResolvedValue({
      version: 1,
      groupingMode: 'manual',
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
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
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
      groupingMode: 'manual',
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
    const onCreateSession = vi.fn(async () => ({ created }))
    const onCreated = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'gizmo-work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        panes={[{ ...pane('%1', 0, 'Gizmo shell'), path: '/Users/dev/gizmo' }]}
        displayedPaneIds={['%1']}
        statuses={{}}
        selectedSessionId="$1"
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
        creation={{
          onCreateSession,
          onCreated,
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in GIZMO' }))
    const dialog = await screen.findByRole('dialog', { name: 'New session' })
    expect(within(dialog).getByText('GIZMO')).toBeVisible()
    expect(within(dialog).getByRole('combobox', { name: /Working directory/ })).toHaveValue('/Users/dev/gizmo')
    fireEvent.change(within(dialog).getByLabelText('Session name'), { target: { value: 'new-gizmo-work' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }))

    await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledWith({
      version: 1,
      groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1', '$2'] }],
      ungroupedSessionIds: [],
      groupingMode: 'manual',
    }))
    expect(onCreateSession).toHaveBeenCalledWith({
      name: 'new-gizmo-work',
      windowName: '',
      cwd: '/Users/dev/gizmo',
      empty: true,
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
      groupingMode: 'manual',
    })
    let resolveCreate: ((created: TmuxCreatedTarget) => void) | undefined
    const onCreateSession = vi.fn(() => new Promise<{ created: TmuxCreatedTarget }>((resolve) => {
      resolveCreate = (created) => resolve({ created })
    }))
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'gizmo-work', attached: true, activeWindowId: null, windowIds: [] }]}
        panes={[]}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId="$1"
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
        creation={{
          onCreateSession,
        }}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in GIZMO' }))
    const dialog = await screen.findByRole('dialog', { name: 'New session' })
    fireEvent.change(within(dialog).getByLabelText('Session name'), { target: { value: 'pending-session' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }))
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
      groupingMode: 'manual',
    })
  })

  it('shows a leased simulator glyph that opens the simulator', () => {
    const onShowSimulator = vi.fn()
    render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }, { id: '$2', name: 'other', attached: false, activeWindowId: null, windowIds: [] }]}
        panes={[pane('%1', 0, 'Shell'), pane('%2', 1, 'Agent')]}
        displayedPaneIds={['%1', '%2']}
        statuses={{}}
        simulators={{ '%2': { udid: 'SIM-1', label: 'work · checkout', task: 'checkout', sessionName: 'work', ports: [], idle: true } }}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
        onShowSimulator={onShowSimulator}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const glyph = screen.getByRole('button', { name: 'Show leased simulator for work' })
    expect(glyph).toHaveClass('idle')
    expect(glyph).toHaveAttribute('title', 'Simulator · work · checkout · checkout')
    expect(screen.queryByRole('button', { name: 'Show leased simulator for other' })).not.toBeInTheDocument()
    fireEvent.click(glyph)
    expect(onShowSimulator).toHaveBeenCalledWith('SIM-1', '%2')
  })

  it('shows one status indicator for the most urgent pane', () => {
    const panes = [
      pane('%1', 0, 'Claude pane'),
      pane('%2', 1, 'No agent'),
      pane('%3', 2, 'Codex pane'),
      pane('%4', 3, 'Cursor pane'),
    ]
    const onSelectPane = vi.fn()
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        panes={panes}
        displayedPaneIds={['%3', '%2', '%1']}
        statuses={{
          '%1': agentStatus('%1', 'claude', 'working'),
          '%3': agentStatus('%3', 'codex', 'needs_input'),
          '%4': agentStatus('%4', 'cursor', 'stale'),
        }}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={onSelectPane}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const indicators = [...container.querySelectorAll('button.session-indicator')]
    expect(indicators).toHaveLength(1)
    const label = 'Codex: blocked on you - Codex pane; Claude: working - Claude pane; Cursor: idle - Cursor pane'
    expect(indicators[0]).toHaveAttribute('aria-label', label)
    expect(indicators[0]).toHaveAttribute('title', label)
    expect(indicators[0]).toHaveClass('needs_input')
    fireEvent.click(indicators[0])
    expect(onSelectPane).toHaveBeenCalledWith('%3')
    expect(container.querySelector('.live-dot')).not.toBeInTheDocument()
  })

  it('shows a turn ended since the pane was seen as to review, then idle once seen', () => {
    const panes = [pane('%1', 0, 'Claude pane')]
    const statuses = { '%1': { ...agentStatus('%1', 'claude', 'done'), settledAt: 10 } }
    const props = {
      token: 'token',
      sessions: [{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }],
      panes,
      displayedPaneIds: ['%1'],
      statuses,
      selectedSessionId: null,
      onSelectSession: vi.fn(),
      onSelectPane: vi.fn(),
      onSessionsChanged: vi.fn(),
      onPreferencesChanged: vi.fn(),
    }
    const { container, rerender } = render(<SessionTree {...props} seen={{ '%1': 5 }} />)
    const indicator = () => container.querySelector('button.session-indicator')
    expect(indicator()).toHaveClass('review')
    expect(indicator()).toHaveAttribute('title', 'Claude: to review - Claude pane')

    rerender(<SessionTree {...props} seen={{ '%1': 10 }} />)
    expect(indicator()).toHaveClass('idle')
    expect(indicator()).toHaveAttribute('title', 'Claude: idle - Claude pane')
  })

  it('folds pane marks into the status indicator', () => {
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
        panes={panes}
        displayedPaneIds={['%1', '%2']}
        statuses={{ '%1': agentStatus('%1', 'claude', 'working') }}
        marks={marks}
        selectedSessionId="$1"
        onSelectSession={vi.fn()}
        onSelectPane={onSelectPane}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    const indicators = [...container.querySelectorAll<HTMLButtonElement>('button.session-indicator')]
    expect(indicators).toHaveLength(1)
    expect(indicators[0]).toHaveClass('mark', 'tone-red', 'has-activity')
    expect(indicators[0]).toHaveAttribute('aria-label', 'Claude: working - Release pane; Waiting for PR - Release pane; Blocked, 3 activities since mark - API pane')
    fireEvent.click(indicators[0])
    expect(onSelectPane).toHaveBeenCalledWith('%2')
  })

  it('does not show attachment or placeholder dots without pane statuses', () => {
    const panes = [pane('%1', 0, 'No agent')]
    const { container } = render(
      <SessionTree
        token="token"
        sessions={[{ id: '$1', name: 'attached', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
        panes={panes}
        displayedPaneIds={['%1']}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
      />,
    )

    expect(container.querySelector('button.session-indicator')).not.toBeInTheDocument()
    expect(container.querySelector('.live-dot')).not.toBeInTheDocument()
  })

  describe('repository grouping', () => {
    const SAVE_ALL: PaneRepo = { root: '/Users/dev/gizmo/Save-All', name: 'Save-All', branch: 'main', isWorktree: false, defaultBranch: 'main' }
    const COINS: PaneRepo = { ...SAVE_ALL, branch: 'referral-coins-reward', isWorktree: true }
    const VIVIFIT: PaneRepo = { root: '/Users/dev/vivifit', name: 'vivifit', branch: 'main', isWorktree: false, defaultBranch: 'main' }
    const sessions = [
      { id: '$1', name: 'Team Battles', attached: false, activeWindowId: '@1', windowIds: ['@1'] },
      { id: '$2', name: 'Coins everywhere', attached: false, activeWindowId: '@2', windowIds: ['@2'] },
      { id: '$3', name: 'CI', attached: false, activeWindowId: '@3', windowIds: ['@3'] },
      { id: '$4', name: 'scratch', attached: false, activeWindowId: '@4', windowIds: ['@4'] },
    ]
    const panes = [
      { ...pane('%1', 0, 'shell'), sessionId: '$1', windowId: '@1', path: SAVE_ALL.root, repo: SAVE_ALL },
      { ...pane('%2', 0, 'shell'), sessionId: '$2', windowId: '@2', path: `${SAVE_ALL.root}-worktrees/coins`, repo: COINS },
      { ...pane('%3', 0, 'shell'), sessionId: '$3', windowId: '@3', path: VIVIFIT.root, repo: VIVIFIT },
      { ...pane('%4', 0, 'shell'), sessionId: '$4', windowId: '@4', path: '/tmp/plain' },
    ]
    const renderTree = (overrides: Partial<Parameters<typeof SessionTree>[0]> = {}) => render(
      <SessionTree
        token="token"
        sessions={sessions}
        panes={panes}
        displayedPaneIds={[]}
        statuses={{}}
        selectedSessionId={null}
        onSelectSession={vi.fn()}
        onSelectPane={vi.fn()}
        onSessionsChanged={vi.fn()}
        onPreferencesChanged={vi.fn()}
        {...overrides}
      />,
    )

    it('groups sessions by repository by default and marks sessions on a non-default branch', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] }], ungroupedSessionIds: [] })
      renderTree()
      const headings = await screen.findAllByRole('button', { name: /^Collapse / })
      expect(headings.map((heading) => heading.getAttribute('aria-label'))).toEqual([
        'Collapse Save-All',
        'Collapse vivifit',
        'Collapse No repository',
      ])
      expect(screen.queryByRole('button', { name: 'Collapse GIZMO' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Move Save-All down' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Group$/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Coins everywhere' })).toHaveAttribute('title', `Coins everywhere — ${deriveSessionIdentity('Coins everywhere').codename} · referral-coins-reward · 1 window / 1 pane`)
      expect(screen.getByRole('button', { name: 'Group sessions by repository' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('switches to manual grouping and persists the choice', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] }], ungroupedSessionIds: [] })
      renderTree()
      await screen.findByRole('button', { name: 'Collapse Save-All' })
      fireEvent.click(screen.getByRole('button', { name: 'Group sessions manually' }))
      expect(await screen.findByRole('button', { name: 'Collapse GIZMO' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Group$/ })).toBeInTheDocument()
      await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenCalledWith({
        version: 1,
        groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$1'] }],
        ungroupedSessionIds: [],
        groupingMode: 'manual',
      }))
    })

    it('reorders within a repository, persists across modes and reload, and updates shortcuts', async () => {
      const initial = { version: 1 as const, groups: [{ id: 'gizmo', name: 'GIZMO', sessionIds: ['$2', '$1'] }], ungroupedSessionIds: ['$3', '$4'] }
      sessionApi.loadPreferences.mockResolvedValue(initial)
      const onSelectSession = vi.fn()
      const tree = renderTree({ onSelectSession })
      await waitFor(() => expect(sessionApi.loadPreferences).toHaveBeenCalled())
      const repo = screen.getByRole('button', { name: 'Collapse Save-All' }).closest('section')!
      const names = () => [...repo.querySelectorAll('.managed-session-main')].map((node) => node.textContent)
      const team = screen.getByRole('button', { name: 'Actions for Team Battles' }).closest('article')!
      const coins = screen.getByRole('button', { name: 'Actions for Coins everywhere' }).closest('article')!
      expect(team).toHaveAttribute('draggable', 'true')
      fireEvent.dragStart(team)
      fireEvent.drop(coins)
      expect(names()).toEqual(['Team Battles', 'Coins everywhere'])
      const saved = { ...initial, repositorySessionIds: ['$1', '$2'] }
      await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenLastCalledWith(saved))
      fireEvent.keyDown(window, { key: '1', metaKey: true })
      expect(onSelectSession).toHaveBeenLastCalledWith('$1')
      fireEvent.click(screen.getByRole('button', { name: 'Group sessions manually' }))
      const manualGroup = await screen.findByRole('button', { name: 'Collapse GIZMO' })
      expect([...manualGroup.closest('section')!.querySelectorAll('.managed-session-main')].map((node) => node.textContent)).toEqual(['Coins everywhere', 'Team Battles'])
      fireEvent.click(screen.getByRole('button', { name: 'Group sessions by repository' }))
      await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenLastCalledWith({ ...saved, groupingMode: 'repository' }))
      tree.unmount()
      sessionApi.loadPreferences.mockResolvedValue(saved)
      renderTree()
      await waitFor(() => expect([...screen.getByRole('button', { name: 'Collapse Save-All' }).closest('section')!.querySelectorAll('.managed-session-main')].map((node) => node.textContent)).toEqual(['Team Battles', 'Coins everywhere']))
    })

    it('rejects cross-repo and self drops, and allows dropping on the group to move to the end', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      renderTree()
      await waitFor(() => expect(sessionApi.loadPreferences).toHaveBeenCalled())
      const coins = screen.getByRole('button', { name: 'Actions for Coins everywhere' }).closest('article')!
      const ci = screen.getByRole('button', { name: 'Actions for CI' }).closest('article')!
      const noRepo = screen.getByRole('button', { name: 'Collapse No repository' }).closest('section')!
      fireEvent.dragStart(coins)
      expect(fireEvent.dragOver(ci)).toBe(true)
      fireEvent.drop(ci)
      fireEvent.drop(noRepo)
      fireEvent.drop(coins)
      expect(sessionApi.savePreferences).not.toHaveBeenCalled()
      fireEvent.dragStart(coins)
      fireEvent.drop(screen.getByRole('button', { name: 'Collapse Save-All' }).closest('section')!)
      await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ repositorySessionIds: ['$1', '$2'] })))
    })

    it('also reorders sessions within No repository', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      renderTree({ panes: [] })
      await waitFor(() => expect(sessionApi.loadPreferences).toHaveBeenCalled())
      fireEvent.dragStart(screen.getByRole('button', { name: 'Actions for Team Battles' }).closest('article')!)
      fireEvent.drop(screen.getByRole('button', { name: 'Actions for CI' }).closest('article')!)
      await waitFor(() => expect(sessionApi.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ repositorySessionIds: ['$1', '$3', '$2', '$4'] })))
    })

    it('offers linked worktree deletion only for a worktree-backed session', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const onSessionsChanged = vi.fn()
      renderTree({ onSessionsChanged })
      await screen.findByRole('button', { name: 'Collapse Save-All' })

      fireEvent.click(screen.getByRole('button', { name: 'Actions for Team Battles' }))
      expect(screen.queryByRole('menuitem', { name: 'Delete session and worktree' })).not.toBeInTheDocument()
      fireEvent.pointerDown(window)

      fireEvent.click(screen.getByRole('button', { name: 'Actions for Coins everywhere' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session and worktree' }))

       await waitFor(() => expect(sessionApi.deleteSession).toHaveBeenCalledWith('$2', true, []))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Uncommitted changes.*branch will be kept/s))
      expect(onSessionsChanged).toHaveBeenCalled()
    })

    it('separates same-worktree background sessions and names them in the delete confirmation', async () => {
      const root = `${SAVE_ALL.root}-worktrees/cleanup`
      const repo: PaneRepo = { ...SAVE_ALL, worktreeRoot: root, branch: 'cleanup', isWorktree: true }
      const main = { id: '$10', name: 'Cleanup', attached: false, activeWindowId: '@10', windowIds: ['@10'] }
      const helper = { id: '$11', name: 'native_app-cleanup', attached: false, activeWindowId: '@11', windowIds: ['@11'] }
      const impostor = { id: '$12', name: 'native_app-unrelated', attached: false, activeWindowId: '@12', windowIds: ['@12'] }
      const namedPanes = [
        { ...pane('%10', 0, 'agent'), sessionId: main.id, windowId: '@10', path: root, repo },
        { ...pane('%11', 0, 'tilt'), sessionId: helper.id, windowId: '@11', path: root, repo },
        { ...pane('%12', 0, 'agent'), sessionId: impostor.id, windowId: '@12', path: root, repo },
      ]
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [], groupingMode: 'repository' })
      sessionApi.previewWorktreeDeletion.mockResolvedValue({ auxiliarySessions: [{ id: '$11', name: helper.name }] })
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const onSelectSession = vi.fn()
      renderTree({ sessions: [main, helper, impostor], panes: namedPanes, onSelectSession })
      const background = await screen.findByRole('button', { name: 'Collapse Save-All' })
      expect(background).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Expand Background sessions' })).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('button', { name: 'Actions for native_app-cleanup' })).not.toBeInTheDocument()
      fireEvent.keyDown(window, { key: '1', metaKey: true })
      expect(onSelectSession).toHaveBeenCalledWith(main.id)
      fireEvent.click(screen.getByRole('button', { name: 'Expand Background sessions' }))
      expect(screen.getByRole('button', { name: 'Actions for native_app-cleanup' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Actions for native_app-unrelated' })).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Cleanup' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session and worktree' }))
      await waitFor(() => expect(sessionApi.deleteSession).toHaveBeenCalledWith(main.id, true, [helper.id]))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('• native_app-cleanup'))
    })

    it('keeps generated sessions in the collapsible background section in manual mode', async () => {
      const root = `${SAVE_ALL.root}-worktrees/cleanup`
      const repo: PaneRepo = { ...SAVE_ALL, worktreeRoot: root, branch: 'cleanup', isWorktree: true }
      const helper = { id: '$11', name: 'tilt-cleanup', attached: false, activeWindowId: '@11', windowIds: ['@11'] }
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groupingMode: 'manual', groups: [{ id: 'tools', name: 'Tools', sessionIds: [helper.id] }], ungroupedSessionIds: [] })
      renderTree({ sessions: [helper], panes: [{ ...pane('%11', 0, 'tilt'), sessionId: helper.id, windowId: '@11', path: root, repo }] })
      await screen.findByRole('button', { name: 'Expand Background sessions' })
      expect(screen.getByRole('button', { name: 'Collapse Tools' }).closest('section')).not.toHaveTextContent(helper.name)
      fireEvent.click(screen.getByRole('button', { name: 'Expand Background sessions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Actions for tilt-cleanup' }))
      expect(screen.queryByRole('menuitem', { name: 'Delete session and worktree' })).not.toBeInTheDocument()
      expect(screen.queryByRole('menuitem', { name: 'Archive session' })).not.toBeInTheDocument()
      expect(screen.getByRole('menuitem', { name: 'Delete session' })).toBeInTheDocument()
    })

    it('archives a session and offers a restore action for its saved panes', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      const archived = { id: 'archive-id', name: 'Coins everywhere', createdAt: Date.now(), windowCount: 2, paneCount: 3 }
      sessionApi.listArchives.mockResolvedValueOnce([]).mockResolvedValueOnce([archived]).mockResolvedValueOnce([])
      sessionApi.archiveSession.mockResolvedValue(undefined)
      sessionApi.restoreSession.mockResolvedValue('$99')
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const onSessionsChanged = vi.fn()
      renderTree({ onSessionsChanged })
      fireEvent.click(await screen.findByRole('button', { name: 'Actions for Coins everywhere' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
      await waitFor(() => expect(sessionApi.archiveSession).toHaveBeenCalledWith('$2'))
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('fresh shells'))
      expect(await screen.findByRole('button', { name: 'Restore Coins everywhere' })).toBeInTheDocument()
      expect(screen.getByText('2 windows / 3 panes')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Restore Coins everywhere' }))
      await waitFor(() => expect(sessionApi.restoreSession).toHaveBeenCalledWith('archive-id'))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore Coins everywhere' })).not.toBeInTheDocument())
      expect(onSessionsChanged).toHaveBeenCalledTimes(2)
    })

    it('lets another menu skip or replace the archive and delete dialogs, but always confirms deleting a worktree', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      sessionApi.archiveSession.mockResolvedValue(undefined)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const actions = { current: null as SessionActions | null }
      renderTree({ actionsRef: actions })
      await screen.findByRole('button', { name: 'Actions for Coins everywhere' })
      await act(() => actions.current!.archiveSession('$2', null))
      await act(() => actions.current!.deleteSession('$1', false, null))
      expect(confirm).not.toHaveBeenCalled()
      expect(sessionApi.archiveSession).toHaveBeenCalledWith('$2')
      expect(sessionApi.deleteSession).toHaveBeenCalledWith('$1', false, [])
      confirm.mockReturnValue(false)
      await act(() => actions.current!.archiveSession('$2', 'Two processes will stop'))
      expect(confirm).toHaveBeenLastCalledWith('Two processes will stop')
      expect(sessionApi.archiveSession).toHaveBeenCalledTimes(1)
      await act(() => actions.current!.deleteSession('$2', true, 'Two processes will stop'))
      expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Two processes will stop\n\nDelete tmux session “Coins everywhere” and its linked worktree\?.*Uncommitted changes/s))
      await act(() => actions.current!.deleteSession('$2', true, null))
      expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(/^Delete tmux session “Coins everywhere” and its linked worktree\?/))
      expect(sessionApi.deleteSession).toHaveBeenCalledTimes(1)
      const onError = vi.fn()
      confirm.mockReturnValue(true)
      sessionApi.archiveSession.mockRejectedValueOnce(new Error('Daemon said no'))
      await act(() => actions.current!.archiveSession('$2', null, onError))
      expect(onError).toHaveBeenCalledWith('Daemon said no')
      expect(screen.queryByText('Daemon said no')).toBeNull()
    })

    it('keeps the dialog open when Escape dismisses directory suggestions, then closes on Escape', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      const onCreateSession = vi.fn()
      renderTree({ creation: { onCreateSession } })
      fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in Save-All' }))
      const dialog = await screen.findByRole('dialog', { name: 'New session' })
      expect(within(dialog).getByText('Save-All')).toBeVisible()
      const directory = within(dialog).getByRole('combobox', { name: /Working directory/ })
      expect(directory).toHaveValue(SAVE_ALL.root)
      expect(within(dialog).getByLabelText('Session name')).toHaveFocus()
      fireEvent.focus(directory)
      expect(within(dialog).getByRole('listbox', { name: 'Suggested working directories' })).toBeInTheDocument()
      fireEvent.keyDown(directory, { key: 'Escape' })
      expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument()
      expect(within(dialog).queryByRole('listbox')).not.toBeInTheDocument()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(screen.getByRole('button', { name: 'Create a new session in Save-All' })).toHaveFocus()
    })

    it('keeps the dialog open while session creation is pending and closes after success', async () => {
      sessionApi.loadPreferences.mockResolvedValue({ version: 1, groups: [], ungroupedSessionIds: [] })
      let resolveCreate: ((value: { created: TmuxCreatedTarget }) => void) | undefined
      const onCreateSession = vi.fn(() => new Promise<{ created: TmuxCreatedTarget }>((resolve) => {
        resolveCreate = resolve
      }))
      renderTree({ creation: { onCreateSession } })
      fireEvent.click(await screen.findByRole('button', { name: 'Create a new session in Save-All' }))
      const dialog = await screen.findByRole('dialog', { name: 'New session' })
      fireEvent.change(within(dialog).getByLabelText('Session name'), { target: { value: 'new-save-all-session' } })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create session' }))

      expect(dialog).toHaveAttribute('aria-busy', 'true')
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled()
      fireEvent.keyDown(dialog, { key: 'Escape' })
      expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument()

      resolveCreate?.({
        created: {
          kind: 'session',
          sessionId: '$5',
          sessionName: 'new-save-all-session',
          windowId: '@5',
          windowIndex: 0,
          windowName: 'shell',
          paneId: '%5',
          paneIndex: 0,
          panePath: `${SAVE_ALL.root}-worktrees/new-save-all-session`,
        },
      })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })
  })
})

describe('agent chat sidebar', () => {
  it('shows a lineage glyph for a session opened from another session and a request badge in the row meta', async () => {
    const parent = { ...pane('%1', 0, 'Parent'), sessionId: '$1' }
    const child = { ...pane('%2', 0, 'Child'), sessionId: '$2', windowId: '@2', openedBy: parent.targetId }
    const sibling = { ...pane('%3', 1, 'Sibling'), openedBy: parent.targetId }
    const onSelectPane = vi.fn(), onSelectSession = vi.fn()
    const props = {
      token: '', sessions: [{ id: '$1', name: 'main', attached: true, activeWindowId: '@1', windowIds: ['@1'] }, { id: '$2', name: 'child', attached: false, activeWindowId: '@2', windowIds: ['@2'] }],
      windows: [{ id: '@1', sessionId: '$1', name: 'shell', index: 0, active: true, layout: '', paneIds: ['%1', '%3'] }, { id: '@2', sessionId: '$2', name: 'shell', index: 0, active: true, layout: '', paneIds: ['%2'] }],
      panes: [parent, child, sibling], displayedPaneIds: ['%1', '%3'], statuses: { '%1': { ...agentStatus('%1', 'claude', 'working'), agentSessionName: 'implementation' } },
      selectedSessionId: '$1', focusedPaneId: '%1', onSelectPane, onSelectSession, onSelectWindow: vi.fn(), onOpenPaneMaximized: vi.fn(), onWindowDeleting: vi.fn(), onSessionsChanged: vi.fn(), onPreferencesChanged: vi.fn(),
      agentChatRequests: { 'cr-123': { id: 'cr-123', callerPaneId: '%2', callerTargetId: child.targetId, requestedBy: 'claude', reason: 'rate' as const, requestedAt: 0, summary: { location: 'pane' as const, title: 'Review', provider: 'claude' as const, promptPreview: 'brief' } } },
    }
    const { rerender } = render(<SessionTree {...props} />)
    await act(async () => {})
    // Only a session opened from another session gets the glyph; a sibling pane is attributed in its own pane.
    const marker = screen.getByRole('button', { name: 'Opened by claude · implementation in main' })
    expect(marker).toHaveClass('opened-by-marker')
    expect(marker.closest('.session-row-meta')).toBeTruthy()
    expect(marker.closest('.managed-session-row')).toHaveTextContent('child')
    fireEvent.click(marker)
    expect(onSelectPane).toHaveBeenLastCalledWith('%1')
    expect(onSelectSession).not.toHaveBeenCalled()
    const badge = screen.getByRole('button', { name: 'claude wants to open a chat' })
    expect(badge.textContent).toBe('')
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(badge.closest('.session-row-meta')).toBeTruthy()
    expect(badge.closest('.managed-session-row')).toHaveTextContent('child')
    expect(document.querySelector('button button')).toBeNull()
    fireEvent.click(badge)
    expect(onSelectPane).toHaveBeenLastCalledWith('%2')
    expect(onSelectSession).not.toHaveBeenCalled()
    rerender(<SessionTree {...props} panes={[child, sibling]} agentChatRequests={{}} />)
    expect(screen.queryByRole('button', { name: /^Opened by/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'claude wants to open a chat' })).not.toBeInTheDocument()
  })
})

it('offers Resume a chat between Rename and Archive and passes the session id', async () => {
  const onResumeChat = vi.fn()
  render(<SessionTree
    token="token" sessions={[{ id: '$1', name: 'work', attached: true, activeWindowId: '@1', windowIds: ['@1'] }]}
    panes={[pane('%1', 0, 'Agent pane')]} displayedPaneIds={['%1']} statuses={{}} selectedSessionId="$1"
    onSelectSession={vi.fn()} onSelectPane={vi.fn()} onSessionsChanged={vi.fn()} onPreferencesChanged={vi.fn()}
    onResumeChat={onResumeChat} connected
  />)
  await screen.findByRole('button', { name: 'Group sessions manually', pressed: true })
  fireEvent.click(screen.getByRole('button', { name: 'Actions for work' }))
  const items = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
  expect(items.indexOf('Resume a chat…')).toBe(items.indexOf('Rename') + 1)
  expect(items.indexOf('Archive session')).toBe(items.indexOf('Resume a chat…') + 1)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Resume a chat…' }))
  expect(onResumeChat).toHaveBeenCalledWith('$1')
  expect(onResumeChat).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})


it('renders the saved avatar and codename, validates glyph changes, and resets identity', async () => {
  const identity = { ...deriveSessionIdentity('Subscriptions'), glyph: '🐢', glyphSource: 'user' as const }
  const preferences = { version: 1, groups: [], ungroupedSessionIds: ['$1'], sessionIdentities: { Subscriptions: identity } }
  sessionApi.loadPreferences.mockResolvedValue(preferences)
  sessionApi.changeIdentity.mockImplementation(async (_id, glyph) => ({ ...preferences, sessionIdentities: { Subscriptions: glyph === null ? deriveSessionIdentity('Subscriptions') : { ...identity, glyph } } }))
  const onPreferencesChanged = vi.fn()
  render(<SessionTree token="token" sessions={[{ id: '$1', name: 'Subscriptions', attached: true, activeWindowId: null, windowIds: [] }]}
    panes={[]} displayedPaneIds={[]} statuses={{}} selectedSessionId={null} onSelectSession={vi.fn()} onSelectPane={vi.fn()}
    onSessionsChanged={vi.fn()} onPreferencesChanged={onPreferencesChanged} />)
  const row = await screen.findByRole('button', { name: 'Subscriptions' })
  await waitFor(() => expect(row).toHaveAttribute('title', expect.stringContaining(`Subscriptions — ${identity.codename}`)))
  expect(row.querySelector('.session-avatar svg')).toHaveAttribute('width', '18')
  expect(row.querySelector('.session-avatar')?.innerHTML).toContain(identity.color)
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue('two emojis 💬🐛')
  const actions = () => fireEvent.click(screen.getByRole('button', { name: 'Actions for Subscriptions' }))
  actions()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Change glyph…' }))
  expect(await screen.findByText('Glyph must be a single emoji')).toBeInTheDocument()
  expect(sessionApi.changeIdentity).not.toHaveBeenCalled()
  prompt.mockReturnValue('👩🏽‍💻')
  actions()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Change glyph…' }))
  await waitFor(() => expect(sessionApi.changeIdentity).toHaveBeenCalledWith('$1', '👩🏽‍💻'))
  await waitFor(() => expect(onPreferencesChanged).toHaveBeenLastCalledWith(expect.objectContaining({ sessionIdentities: { Subscriptions: expect.objectContaining({ glyph: '👩🏽‍💻' }) } })))
  actions()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reset identity' }))
  await waitFor(() => expect(sessionApi.changeIdentity).toHaveBeenLastCalledWith('$1', null))
})


describe('Commander session', () => {
  const sessions = [
    { id: '$1', name: 'Work', attached: true, activeWindowId: null, windowIds: [] },
    { id: '$2', name: 'Commander', attached: true, activeWindowId: null, windowIds: [] },
  ]
  const baseProps = {
    token: 'token', sessions, panes: [], displayedPaneIds: [], statuses: {}, selectedSessionId: '$2',
    onSelectSession: vi.fn(), onSelectPane: vi.fn(), onSessionsChanged: vi.fn(), onPreferencesChanged: vi.fn(),
  }
  it('pins Commander once, with attention badges, outside numbered shortcuts', async () => {
    const onSelectSession = vi.fn()
    render(<SessionTree {...baseProps} onSelectSession={onSelectSession}
      commanderState={{ targetId: 'commander', sessionId: '$2', paneId: '%2' }} commanderNeedsYou={2} commanderUnreadFinished />)
    const pinned = screen.getByRole('button', { name: 'Commander' })
    expect(pinned).toHaveClass('session-commander-row', 'selected')
    expect(within(pinned).getByLabelText('2 agents need you')).toHaveTextContent('2')
    expect(within(pinned).getByLabelText('Unread finished turns')).toBeInTheDocument()
    expect(screen.getAllByText('Commander')).toHaveLength(1)
    fireEvent.click(pinned)
    expect(onSelectSession).toHaveBeenLastCalledWith('$2')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Group sessions manually' })).toHaveAttribute('aria-pressed', 'true'))
    fireEvent(window, new CustomEvent(NATIVE_TERMINAL_SHORTCUT_EVENT, { detail: { key: '1' } }))
    expect(onSelectSession).toHaveBeenLastCalledWith('$1')
    expect(pinned.compareDocumentPosition(screen.getByText('Work')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('offers creation when the Commander session is no longer live and surfaces errors', async () => {
    const onCreateCommander = vi.fn().mockRejectedValue(new Error('Unable to start Commander'))
    render(<SessionTree {...baseProps} sessions={[sessions[0]]} commanderState={{ targetId: 'commander', sessionId: '$2' }} onCreateCommander={onCreateCommander} />)
    fireEvent.click(screen.getByRole('button', { name: 'Commander' }))
    expect(onCreateCommander).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Unable to start Commander')).toBeInTheDocument()
  })
  it('prevents duplicate creation while waiting for the live pane', () => {
    render(<SessionTree {...baseProps} sessions={[sessions[0]]} commanderOpening onCreateCommander={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled()
  })
})
