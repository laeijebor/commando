// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '../shared/agent-chat'
import type { ChatConversation } from '../shared/chat-conversations'
import type { TmuxPane } from '../shared/protocol'
import { ConversationPicker, openConversationPanes } from './ConversationPicker'

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)

const NOW = Date.UTC(2026, 9, 13, 21)
const pane = { id: '%1', sessionId: '$1', path: '/Users/me/app-worktrees/feature', repo: { root: '/Users/me/app', name: 'app', branch: 'feature', isWorktree: true, worktreeRoot: '/Users/me/app-worktrees/feature' } } as TmuxPane
const conversation = (sessionId: string, title: string, cwd: string, minutesAgo: number, extra: Partial<ChatConversation> = {}): ChatConversation => ({
  provider: 'claude', sessionId, title, cwd, updatedAt: NOW - minutesAgo * 60_000, repoRoot: cwd.startsWith('/Users/me/app') ? '/Users/me/app' : '/Users/me/other', checkoutRoot: cwd, ...extra,
})
const conversations = [
  conversation('aaaaaaaa-0001', 'Elsewhere work', '/Users/me/other', 1),
  conversation('aaaaaaaa-0002', 'Main checkout work', '/Users/me/app', 5, { session: { id: '$2', name: 'vivi', group: 'Subscriptions' } }),
  conversation('aaaaaaaa-0003', 'Feature work', '/Users/me/app-worktrees/feature', 90, { branch: 'feature', session: { id: '$1', name: 'current' } }),
  conversation('aaaaaaaa-0004', 'Open elsewhere', '/Users/me/app-worktrees/feature', 2, { session: { id: '$1', name: 'current' } }),
]

function renderPicker(overrides: Partial<Parameters<typeof ConversationPicker>[0]> = {}) {
  const props = {
    pane,
    sessionName: 'current',
    chats: { '%7': { session: { provider: 'claude', sessionId: 'aaaaaaaa-0004' } } } as unknown as Record<string, ChatState>,
    paneLabel: () => 'Review',
    busy: false,
    load: vi.fn(async () => conversations),
    onPick: vi.fn(async () => {}),
    onJump: vi.fn(),
    onClose: vi.fn(),
    now: NOW,
    ...overrides,
  }
  render(<ConversationPicker {...props} />)
  return { ...props, input: screen.getByRole('textbox', { name: 'Search conversations' }) }
}

describe('ConversationPicker', () => {
  it('labels Cursor and OpenCode conversations', async () => {
    renderPicker({ load: async () => [
      conversation('aaaaaaaa-0005', 'Cursor work', pane.path, 1, { provider: 'cursor' }),
      conversation('ses_session123', 'OpenCode work', pane.path, 2, { provider: 'opencode' }),
    ] })
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.querySelector('.command-kind')?.textContent)).toEqual(['Cursor', 'OpenCode'])
  })

  it.each(['cursor', 'opencode'] as const)('jumps to a server-verified live %s TUI instead of resuming it', async (provider) => {
    const sessionId = provider === 'opencode' ? 'ses_session123' : 'aaaaaaaa-0005'
    const { input, onJump, onPick } = renderPicker({
      load: async () => [conversation(sessionId, 'Open terminal work', pane.path, 1, { provider, openPaneId: '%7' })],
      chats: {},
    })
    expect(await screen.findByRole('option')).toHaveTextContent('Open in Review')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith('%7')
    expect(onPick).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex', 'cursor', 'opencode'] as const)('resumes an exited %s TUI now running vim when the server reports no open pane', async (provider) => {
    const sessionId = provider === 'opencode' ? 'ses_session123' : 'aaaaaaaa-0005'
    const past = conversation(sessionId, 'Exited terminal work', pane.path, 1, { provider })
    const { input, onJump, onPick } = renderPicker({
      load: async () => [past],
      chats: {},
      pane: { ...pane, command: 'vim' },
    })
    expect(await screen.findByRole('option')).not.toHaveTextContent('Open in Review')
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Switch this pane')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(past, 'replace'))
    expect(onJump).not.toHaveBeenCalled()
  })

  it('groups this session, then other sessions, then Outside Commando, newest first', async () => {
    renderPicker()
    const groups = await screen.findAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['This session · current', 'vivi · Subscriptions', 'Outside Commando'])
    expect(within(groups[0]!).getAllByRole('option').map((option) => option.querySelector('strong')?.textContent)).toEqual(['Open elsewhere', 'Feature work'])
    expect(within(groups[0]!).getAllByRole('option')[1]!.querySelector('small')).toHaveTextContent(/^2h ago · feature$/)
    expect(within(groups[0]!).getAllByRole('option')[0]).toHaveTextContent('Open in Review')
    expect(groups[0]!.querySelector('.conversation-picker-group')).toHaveTextContent('This session · current2 chats')
    expect(groups[1]!.querySelector('.conversation-picker-group')).toHaveTextContent('vivi · Subscriptions1 chat')
    expect(groups[1]!.querySelector('.conversation-picker-group')).not.toHaveTextContent('1 chats')
  })

  it('omits a branch equal to the folder while retaining a different branch and the profile', async () => {
    renderPicker({ load: async () => [
      conversation('aaaaaaaa-0010', 'Matching branch', '/repo/chat/', 1, { branch: 'chat', profile: 'claudew' }),
      conversation('aaaaaaaa-0011', 'Different branch', '/repo/chat', 2, { branch: 'main' }),
    ] })
    const options = await screen.findAllByRole('option')
    expect(options[0]!.querySelector('small')).toHaveTextContent(/^1m ago · chat · claudew$/)
    expect(options[1]!.querySelector('small')).toHaveTextContent(/^2m ago · chat · main$/)
  })

  it('shows the agent headline, original title, folder, profile, at most three refs and pane states', async () => {
    const enriched = conversation('aaaaaaaa-0005', 'Original Claude title', '/repo/picker/', 2, {
      headline: 'Session-first picker ready', branch: 'feature', profile: 'claudep', session: { id: '$1', name: 'current' }, paneOpen: true,
      refs: [{ label: 'PR #540', url: 'https://example.com/540' }, { label: 'Preview' }, { label: 'Issue #99' }, { label: 'Fourth ref' }],
    })
    const { input } = renderPicker({ load: async () => [enriched, conversations[2]!] })
    const options = await screen.findAllByRole('option')
    expect(input).toHaveAttribute('placeholder', 'Find a conversation, session or PR…')
    expect(options[0]!.querySelector('strong')).toHaveTextContent('Session-first picker ready')
    expect(options[0]!.querySelector('.conversation-picker-title')).toHaveTextContent('Original Claude title')
    expect(options[0]!.querySelector('small')).toHaveTextContent('2m ago · picker · feature · claudep')
    expect(options[0]!.querySelector('.command-kind')).toHaveTextContent('claudep● open')
    expect(options[1]!.querySelector('.command-kind')).toHaveTextContent('Claudeclosed pane')
    expect(options[0]!.querySelectorAll('.conversation-picker-refs > span')).toHaveLength(3)
    expect(screen.queryByText('Fourth ref')).not.toBeInTheDocument()
    for (const query of ['540', '#540', 'Original ready claudep']) {
      fireEvent.change(input, { target: { value: query } })
      expect(screen.getAllByRole('option')).toHaveLength(1)
      expect(screen.getByRole('option')).toHaveTextContent('PR #540')
    }
  })

  it('filters by provider/profile and closed panes, toggles back to All, and preserves input navigation', async () => {
    const entries = [
      conversation('aaaaaaaa-0010', 'Personal', '/repo', 1, { profile: 'claudep', paneOpen: true, session: { id: '$1', name: 'current' } }),
      conversation('aaaaaaaa-0011', 'Work', '/repo', 2, { profile: 'claudew', paneOpen: false, session: { id: '$1', name: 'current' } }),
      conversation('aaaaaaaa-0012', 'Codex work', '/repo', 3, { provider: 'codex' }),
      conversation('aaaaaaaa-0013', 'Cursor work', '/repo', 4, { provider: 'cursor' }),
      conversation('ses_session123', 'OpenCode work', '/repo', 5, { provider: 'opencode' }),
      ...conversations,
    ]
    const { input, onJump } = renderPicker({ load: async () => entries, current: 'claude:aaaaaaaa-0002' })
    await screen.findAllByRole('option')
    for (const label of ['All', 'claudep', 'claudew', 'Codex', 'Cursor', 'OpenCode', 'Closed panes']) {
      const chip = screen.getByRole('button', { name: label })
      expect(chip).toHaveAttribute('type', 'button')
      expect(chip).not.toHaveAttribute('tabindex', '-1')
    }
    const personal = screen.getByRole('button', { name: 'claudep' })
    fireEvent.click(personal)
    expect(personal).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Personal')
    fireEvent.click(personal)
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Codex work')
    fireEvent.click(screen.getByRole('button', { name: 'Closed panes' }))
    expect(screen.getAllByRole('option').map((option) => option.querySelector('strong')?.textContent)).toEqual(['Work', 'Feature work'])
    fireEvent.change(input, { target: { value: 'feature' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-claude-aaaaaaaa-0011')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'conversation-claude-aaaaaaaa-0004')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith('%7')
  })

  it('switches this pane with Enter, opens beside with ⌘Enter, and jumps to an open one', async () => {
    const { input, onPick, onJump } = renderPicker()
    await screen.findAllByRole('group')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith('%7')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(conversations[2], 'split'))
  })

  it('filters by every word, closes on its own conversation, and keeps errors in view', async () => {
    const onPick = vi.fn(async () => { throw new Error('Its folder no longer exists: /Users/me/other') })
    const { input, onClose } = renderPicker({ onPick, current: 'claude:aaaaaaaa-0002' })
    await screen.findAllByRole('group')
    fireEvent.change(input, { target: { value: 'main work' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('This chat')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onClose).toHaveBeenCalled()
    // Unfiltered, the highlight starts past this chat's own conversation.
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')).toHaveTextContent('Open elsewhere')
    fireEvent.change(input, { target: { value: 'me/other' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Its folder no longer exists')
  })

  it('closes from the Esc button, including while a switch is pending', async () => {
    const { input, onClose } = renderPicker({ chats: {}, onPick: () => new Promise<void>(() => {}) })
    await screen.findAllByRole('group')
    fireEvent.change(input, { target: { value: 'Feature' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('Switching')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close conversations' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape from the search input and focused results', async () => {
    const { input, onClose } = renderPicker()
    const options = await screen.findAllByRole('option')
    const outerKeyDown = vi.fn()
    document.addEventListener('keydown', outerKeyDown)
    try {
      for (const target of [input, options[0]!, screen.getByRole('button', { name: 'Close conversations' })]) {
        target.focus()
        expect(fireEvent.keyDown(target, { key: 'Escape' })).toBe(false)
      }
      expect(onClose).toHaveBeenCalledTimes(3)
      expect(outerKeyDown).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outerKeyDown)
    }
  })

  it('says when the switch would stop a running turn', async () => {
    renderPicker({ busy: true, chats: {} })
    await screen.findAllByRole('group')
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Enter Switch (stops this turn)')
  })
})

describe('openConversationPanes', () => {
  it('is not modal, and closes on a click anywhere outside it or into an embedded page', async () => {
    const { onClose } = renderPicker()
    const dialog = screen.getByRole('dialog', { name: 'Conversations' })
    expect(dialog).not.toHaveAttribute('aria-modal')
    fireEvent.pointerDown((await screen.findAllByRole('option'))[0]!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.blur(window)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('maps server-verified terminal conversations and hosted chats to their panes', () => {
    const chats = { '%1': { session: { provider: 'codex', sessionId: 'cccccccc-0001' } } } as unknown as Record<string, ChatState>
    const listed = [
      conversation('aaaaaaaa-0001', 'Claude', pane.path, 1, { openPaneId: '%2' }),
      conversation('aaaaaaaa-0002', 'Exited', pane.path, 1),
      conversation('aaaaaaaa-0003', 'Cursor', pane.path, 1, { provider: 'cursor', openPaneId: '%4' }),
      conversation('ses_session123', 'OpenCode', pane.path, 1, { provider: 'opencode', openPaneId: '%5' }),
    ]
    expect([...openConversationPanes(chats, listed, (paneId) => `pane ${paneId}`)]).toEqual([
      ['claude:aaaaaaaa-0001', { paneId: '%2', label: 'pane %2' }],
      ['cursor:aaaaaaaa-0003', { paneId: '%4', label: 'pane %4' }],
      ['opencode:ses_session123', { paneId: '%5', label: 'pane %5' }],
      ['codex:cccccccc-0001', { paneId: '%1', label: 'pane %1' }],
    ])
  })

  it('keeps hosted chats authoritative when list data is missing or older', () => {
    const chats = { '%7': { session: { provider: 'claude', sessionId: 'aaaaaaaa-0005' } } } as unknown as Record<string, ChatState>
    for (const listed of [[], [conversation('aaaaaaaa-0005', 'Old host', pane.path, 1, { openPaneId: '%2' })]]) {
      expect(openConversationPanes(chats, listed, () => 'Review').get('claude:aaaaaaaa-0005')).toEqual({ paneId: '%7', label: 'Review' })
    }
  })
})
