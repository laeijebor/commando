// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { SessionTree } from './SessionTree'

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

describe('SessionTree', () => {
  it('moves named groups in their persisted display order', async () => {
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
      />,
    )

    const labels = [...container.querySelectorAll('.managed-pane-main')]
      .map((button) => button.textContent)
    expect(labels).toEqual(['Third tmux pane', 'First tmux pane', 'Second tmux pane'])

    fireEvent.click(screen.getByRole('button', { name: 'Open Third tmux pane maximized' }))
    expect(onOpenPaneMaximized).toHaveBeenCalledWith('%3')
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
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close window zsh' }))

    await waitFor(() => expect(sessionApi.deleteWindow).toHaveBeenCalledWith('@1'))
    expect(onWindowDeleting).toHaveBeenCalledWith('@1')
    expect(onSessionsChanged).toHaveBeenCalled()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('last window'))
  })
})
