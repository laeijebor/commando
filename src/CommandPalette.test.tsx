// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SentMessageMatch } from '../shared/chat-messages'
import { CommandPalette, type PaletteCommand } from './CommandPalette'

afterEach(cleanup)

const NOW = new Date(2026, 10, 24, 15, 30, 0).getTime()

function sampleCommands(run = vi.fn()): PaletteCommand[] {
  return [
    { id: 'session:$1', label: 'Open session: auth-service', detail: '2 windows / attached', kind: 'session', run },
    { id: 'theme:dark', label: 'Theme: Dark', detail: 'Switch color palette', kind: 'action', run: vi.fn() },
  ]
}

const sampleMessages: SentMessageMatch[] = [
  {
    id: 'm-new',
    text: 'Refactor the auth middleware to support refresh tokens',
    sentAt: NOW - 5 * 60_000,
    provider: 'claude',
    sessionId: '11111111-1111-1111-1111-111111111111',
    openPaneId: '%12',
    itemId: 'u2',
    sessionName: 'auth-service',
    chatTitle: 'Refresh token flow',
    providerLabel: 'claudew',
    cwd: '/repo/auth-service',
    branch: 'feat/refresh',
    paneOpen: true,
  },
  {
    id: 'm-old',
    text: 'Check auth token expiry handling',
    sentAt: new Date(2026, 10, 23, 14, 10, 0).getTime(),
    provider: 'codex',
    sessionId: '22222222-2222-2222-2222-222222222222',
    sessionName: 'billing-api',
    chatTitle: 'JWT expiry audit',
    providerLabel: 'Codex',
    cwd: '/repo/billing',
    branch: 'main',
    paneOpen: false,
  },
]

describe('CommandPalette', () => {
  it('hides sent messages when fewer than 3 characters are typed', () => {
    render(
      <CommandPalette
        query="au"
        onQueryChange={vi.fn()}
        commands={sampleCommands()}
        messages={sampleMessages}
        messagesActive={false}
        messagesLoading={false}
        messagesIndexing={false}
        onSelectMessage={vi.fn()}
        onClose={vi.fn()}
        now={NOW}
      />,
    )

    expect(screen.queryByRole('group', { name: 'Sent messages' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('renders sent messages underneath regular options with session name, chat details, and time sent', () => {
    render(
      <CommandPalette
        query="auth"
        onQueryChange={vi.fn()}
        commands={sampleCommands()}
        messages={sampleMessages}
        messagesActive
        messagesLoading={false}
        messagesIndexing={false}
        onSelectMessage={vi.fn()}
        onClose={vi.fn()}
        now={NOW}
      />,
    )

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    // Regular command stays first; sent messages appear underneath in recency order.
    expect(options[0]).toHaveAttribute('id', 'session:$1')
    expect(options[1]).toHaveAttribute('id', 'sent-message:m-new')
    expect(options[2]).toHaveAttribute('id', 'sent-message:m-old')

    expect(options[1]).toHaveTextContent('Refactor the auth middleware to support refresh tokens')
    expect(options[1]).toHaveTextContent('auth-service')
    expect(options[1]).toHaveTextContent('claudew · Refresh token flow · feat/refresh · open')
    expect(options[1]).toHaveTextContent('5m ago')

    expect(options[2]).toHaveTextContent('billing-api')
    expect(options[2]).toHaveTextContent('Codex · JWT expiry audit · billing · main · closed')
    expect(options[2]).toHaveTextContent(/Yesterday /)
  })

  it('navigates seamlessly across regular commands and sent messages with Arrow keys and Enter', () => {
    const runCommand = vi.fn()
    const onSelectMessage = vi.fn()

    render(
      <CommandPalette
        query="auth"
        onQueryChange={vi.fn()}
        commands={sampleCommands(runCommand)}
        messages={sampleMessages}
        messagesActive
        messagesLoading={false}
        messagesIndexing={false}
        onSelectMessage={onSelectMessage}
        onClose={vi.fn()}
        now={NOW}
      />,
    )

    const input = screen.getByRole('textbox', { name: 'Search commands' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(runCommand).not.toHaveBeenCalled()
    expect(onSelectMessage).toHaveBeenCalledWith(sampleMessages[1])
  })
})
