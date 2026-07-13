// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TmuxPane } from '../shared/protocol'
import { AuthGate, TerminalPaneCard } from './App'

vi.mock('./authClient', () => ({
  createOwner: vi.fn(),
  getAuthBootstrap: vi.fn(),
  getAuthUser: vi.fn(),
  signInWithEmail: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('./XtermPane', () => ({ XtermPane: () => null }))

afterEach(cleanup)

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
  onKey: vi.fn(),
  onPaste: vi.fn(),
  onResize: vi.fn(),
  registerSink: vi.fn(() => () => undefined),
  registerFocusable: vi.fn(),
}

describe('terminal pane actions', () => {
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

  it('opens the context menu for the targeted pane on Command-right click', () => {
    const onOpenMenu = vi.fn()
    const onFocus = vi.fn()
    const view = render(
      <TerminalPaneCard {...paneProps} onFocus={onFocus} onOpenMenu={onOpenMenu} />,
    )

    fireEvent.contextMenu(view.container.querySelector('[data-pane-id="%12"]')!, {
      clientX: 120,
      clientY: 80,
      metaKey: true,
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
