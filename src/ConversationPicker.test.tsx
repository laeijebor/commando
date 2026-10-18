// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatState } from '../shared/agent-chat'
import type { ChatConversation } from '../shared/chat-conversations'
import type { AgentStatus, TmuxPane } from '../shared/protocol'
import { ConversationPicker, openConversationPanes } from './ConversationPicker'

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(cleanup)

const NOW = Date.UTC(2026, 9, 13, 21)
const pane = { id: '%1', path: '/Users/me/app-worktrees/feature', repo: { root: '/Users/me/app', name: 'app', branch: 'feature', isWorktree: true, worktreeRoot: '/Users/me/app-worktrees/feature' } } as TmuxPane
const conversation = (sessionId: string, title: string, cwd: string, minutesAgo: number, extra: Partial<ChatConversation> = {}): ChatConversation => ({
  provider: 'claude', sessionId, title, cwd, updatedAt: NOW - minutesAgo * 60_000, repoRoot: cwd.startsWith('/Users/me/app') ? '/Users/me/app' : '/Users/me/other', checkoutRoot: cwd, ...extra,
})
const conversations = [
  conversation('aaaaaaaa-0001', 'Elsewhere work', '/Users/me/other', 1),
  conversation('aaaaaaaa-0002', 'Main checkout work', '/Users/me/app', 5),
  conversation('aaaaaaaa-0003', 'Feature work', '/Users/me/app-worktrees/feature', 90, { branch: 'feature' }),
  conversation('aaaaaaaa-0004', 'Open elsewhere', '/Users/me/app-worktrees/feature', 2),
]

function renderPicker(overrides: Partial<Parameters<typeof ConversationPicker>[0]> = {}) {
  const props = {
    pane,
    open: new Map([['claude:aaaaaaaa-0004', { paneId: '%7', label: 'Review' }]]),
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

  it.each(['cursor', 'opencode'] as const)('jumps to a hook-reported %s conversation instead of resuming it', async (provider) => {
    const sessionId = provider === 'opencode' ? 'ses_session123' : 'aaaaaaaa-0005'
    const status: AgentStatus = { paneId: '%7', provider, agentSessionId: sessionId, source: 'hook', status: 'done', summary: '', confidence: 'high', reason: 'Hook report', updatedAt: NOW }
    const { input, onJump, onPick } = renderPicker({
      load: async () => [conversation(sessionId, 'Open terminal work', pane.path, 1, { provider })],
      open: openConversationPanes({}, { '%7': status }, () => 'Review'),
    })
    expect(await screen.findByRole('option')).toHaveTextContent('Open in Review')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onJump).toHaveBeenCalledWith('%7')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('groups this worktree, then this repo, then everything else, newest first', async () => {
    renderPicker()
    const groups = await screen.findAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['This worktree', 'This repo', 'Everything else'])
    expect(within(groups[0]!).getAllByRole('option').map((option) => option.querySelector('strong')?.textContent)).toEqual(['Open elsewhere', 'Feature work'])
    expect(within(groups[0]!).getAllByRole('option')[1]).toHaveTextContent('2h ago · ~/app-worktrees/feature · feature')
    expect(within(groups[0]!).getAllByRole('option')[0]).toHaveTextContent('Open in Review')
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
    const { input, onClose } = renderPicker({ open: new Map(), onPick: () => new Promise<void>(() => {}) })
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
    renderPicker({ busy: true, open: new Map() })
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

  it('maps chat conversations and hook-reported terminal sessions to their panes', () => {
    const chats = { '%1': { session: { provider: 'codex', sessionId: 'cccccccc-0001' } } } as unknown as Record<string, ChatState>
    const statuses = {
      '%2': { provider: 'claude', source: 'hook', agentSessionId: 'aaaaaaaa-0001' },
      '%3': { provider: 'claude', source: 'heuristic', agentSessionId: 'aaaaaaaa-0002' },
      '%4': { provider: 'cursor', source: 'hook', agentSessionId: 'aaaaaaaa-0003' },
      '%5': { provider: 'opencode', source: 'hook', agentSessionId: 'ses_session123' },
      '%6': { provider: 'cursor', source: 'process', agentSessionId: 'aaaaaaaa-0004' },
      '%7': { provider: 'opencode', source: 'heuristic', agentSessionId: 'ses_session456' },
      '%8': { provider: 'unknown', source: 'hook', agentSessionId: 'aaaaaaaa-0005' },
    } as unknown as Record<string, AgentStatus>
    expect([...openConversationPanes(chats, statuses, (paneId) => `pane ${paneId}`)]).toEqual([
      ['claude:aaaaaaaa-0001', { paneId: '%2', label: 'pane %2' }],
      ['cursor:aaaaaaaa-0003', { paneId: '%4', label: 'pane %4' }],
      ['opencode:ses_session123', { paneId: '%5', label: 'pane %5' }],
      ['codex:cccccccc-0001', { paneId: '%1', label: 'pane %1' }],
    ])
  })
})
