// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { SessionTree } from './SessionTree'

vi.mock('./sessionManagementApi', () => ({
  createSessionManagementApi: () => ({
    loadPreferences: async () => ({ version: 1, groups: [], ungroupedSessionIds: [] }),
    savePreferences: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
  }),
}))

afterEach(cleanup)

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
        onSessionsChanged={vi.fn()}
      />,
    )

    const labels = [...container.querySelectorAll('.managed-pane-main')]
      .map((button) => button.textContent)
    expect(labels).toEqual(['Third tmux pane', 'First tmux pane', 'Second tmux pane'])

    fireEvent.click(screen.getByRole('button', { name: 'Open Third tmux pane maximized' }))
    expect(onOpenPaneMaximized).toHaveBeenCalledWith('%3')
  })
})
