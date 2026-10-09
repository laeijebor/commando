// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem, ChatState } from '../../shared/agent-chat'
import { ChatPane } from './ChatPane'
import { deriveTimelineRows, patchLines, pendingRequests, shortPath, workSummary } from './timelineRows'

afterEach(cleanup)

const base = { turnId: 't1', status: 'completed' as const, createdAt: 1, updatedAt: 1 }
const items: ChatItem[] = [
  { ...base, id: 'u1', kind: 'user_message', text: 'Fix the queue' },
  { ...base, id: 'r1', kind: 'reasoning', text: '' },
  { ...base, id: 'read', kind: 'tool', toolUseId: 'a', toolName: 'Read', title: 'Read /work/server/agent-resume.ts' },
  { ...base, id: 'bash', kind: 'command', toolUseId: 'b', command: 'npm test', output: '31 passed' },
  { ...base, id: 'edit', kind: 'file_change', toolUseId: 'c', toolName: 'Edit', path: '/work/server/agent-resume.ts', additions: 2, deletions: 1, patch: '-old\n+new\n+more' },
  { ...base, id: 'a1', kind: 'assistant_message', text: 'Fixed **drain()**.' },
]

function chat(overrides: Partial<ChatState> = {}, extra: ChatItem[] = []): ChatState {
  return {
    paneId: '%5',
    session: { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 1, model: 'claude-opus-5-5', permissionMode: 'default', configDir: '/Users/me/.claudew' },
    items: [...items, ...extra],
    hostConnected: true,
    ...overrides,
  }
}

function renderPane(state: ChatState) {
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn() }
  render(<ChatPane chat={state} connected focused={false} {...handlers} />)
  return handlers
}

describe('timeline rows', () => {
  it('groups tool activity between messages and drops empty finished thoughts', () => {
    const rows = deriveTimelineRows(items)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'work', 'assistant'])
    const work = rows[1]!
    expect(work.kind === 'work' && work.items.map((item) => item.id)).toEqual(['read', 'bash', 'edit'])
    expect(work.kind === 'work' && work.summary).toBe('Ran 1 command, edited 1 file, read 1 file')
  })

  it('keeps open requests out of the timeline and answered ones in the work group', () => {
    const open: ChatItem = { ...base, id: 'q', status: 'running', kind: 'request', requestId: 'q', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?' }
    const answered: ChatItem = { ...base, id: 'p', kind: 'request', requestId: 'p', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', answer: { kind: 'approval', decision: 'allow' } }
    const rows = deriveTimelineRows([...items.slice(0, 4), answered, open])
    expect(rows.at(-1)).toMatchObject({ kind: 'work', summary: 'Ran 1 command, read 1 file, 1 approval' })
    expect(pendingRequests([answered, open]).map((request) => request.requestId)).toEqual(['q'])
  })

  it('summarises, splits patches and shortens session paths', () => {
    expect(workSummary([{ ...base, id: 'x', kind: 'reasoning', text: 'hmm' }])).toBe('Thought')
    expect(patchLines('-a\n+b\n@@\n… 3 more lines').map((line) => line.kind)).toEqual(['del', 'add', 'gap', 'gap'])
    expect(shortPath('Read /work/a.ts and /work/b.ts', '/work')).toBe('Read a.ts and b.ts')
  })
})

describe('ChatPane', () => {
  it('renders messages, a folded work group and the session chips', () => {
    renderPane(chat())
    expect(screen.getByText('Fix the queue')).toBeInTheDocument()
    expect(screen.getByText('drain()')).toBeInTheDocument()
    const group = screen.getByRole('button', { name: 'Ran 1 command, edited 1 file, read 1 file' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(group)
    expect(screen.getByText('server/agent-resume.ts', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument()
    expect(screen.getByText('claudew')).toBeInTheDocument()
  })

  it('sends on Enter, keeps Shift+Enter for new lines, and stops a running turn', () => {
    const handlers = renderPane(chat({ session: { ...chat().session, status: 'running' } }))
    const input = screen.getByRole('textbox', { name: 'Message Claude' })
    fireEvent.change(input, { target: { value: 'next step' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(handlers.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(handlers.onSend).toHaveBeenCalledWith('next step')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(handlers.onInterrupt).toHaveBeenCalled()
  })

  it('answers an approval from the composer', () => {
    const request: ChatItem = { ...base, id: 'request-r9', status: 'running', kind: 'request', requestId: 'r9', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'git push -u origin chat' }
    const handlers = renderPane(chat({}, [request]))
    const panel = screen.getByRole('group', { name: 'Allow Bash?' })
    expect(within(panel).getByText('git push -u origin chat')).toBeInTheDocument()
    fireEvent.click(within(panel).getByRole('button', { name: 'Always allow' }))
    expect(handlers.onAnswer).toHaveBeenCalledWith('r9', { kind: 'approval', decision: 'allow_always' })
  })

  it('answers AskUserQuestion with a picked option or typed text', () => {
    const request: ChatItem = {
      ...base, id: 'request-q1', status: 'running', kind: 'request', requestId: 'q1', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Claude is asking',
      questions: [
        { question: 'Which store?', options: [{ label: 'Postgres' }, { label: 'Redis' }], multiSelect: false },
        { question: 'Name?', options: [], multiSelect: false },
      ],
    }
    const handlers = renderPane(chat({}, [request]))
    const answer = screen.getByRole('button', { name: 'Answer' })
    expect(answer).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Redis' }))
    fireEvent.change(screen.getAllByPlaceholderText('Or type an answer')[1]!, { target: { value: 'sessions' } })
    fireEvent.click(answer)
    expect(handlers.onAnswer).toHaveBeenCalledWith('q1', { kind: 'question', answers: { 'Which store?': 'Redis', 'Name?': 'sessions' } })
  })

  it('disables answers while this browser is offline', () => {
    const request: ChatItem = { ...base, id: 'request-r1', status: 'running', kind: 'request', requestId: 'r1', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?' }
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn() }
    render(<ChatPane chat={chat({}, [request])} connected={false} focused={false} {...handlers} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to Commando')
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled()
  })

  it('says when the host is away and disables the composer', () => {
    renderPane(chat({ hostConnected: false }))
    expect(screen.getByRole('status')).toHaveTextContent('disconnected')
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toBeDisabled()
  })
})
