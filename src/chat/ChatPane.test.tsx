// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TmuxPane } from '../../shared/protocol'
import type { ChatItem, ChatState } from '../../shared/agent-chat'
import { ChatPane } from './ChatPane'
import { deriveTimelineRows, patchLines, pendingRequests, shortPath, thoughtLabel, workSummary } from '../../shared/chat-timeline'

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
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn() }
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
    expect(workSummary([{ ...base, id: 'x', kind: 'command', toolUseId: 'x', command: 'ls' }])).toBe('Ran 1 command')
    expect(patchLines('-a\n+b\n@@\n… 3 more lines').map((line) => line.kind)).toEqual(['del', 'add', 'gap', 'gap'])
    expect(shortPath('Read /work/a.ts and /work/b.ts', '/work')).toBe('Read a.ts and b.ts')
  })
})

describe('ChatPane', () => {
  it('reads the provider for composer labels and the empty timeline', () => {
    renderPane(chat({ session: { ...chat().session, provider: 'codex' }, items: [] }))
    expect(screen.getByRole('textbox', { name: 'Message Codex' })).toHaveAttribute('placeholder', 'Ask Codex… / for commands, @ for files')
    expect(screen.getByText('Ask Codex anything about this folder.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message Claude' })).toBeNull()
  })

  it('renders messages, a faint activity line and the session chips', () => {
    renderPane(chat())
    expect(screen.getByText('Fix the queue')).toBeInTheDocument()
    expect(screen.getByText('drain()')).toBeInTheDocument()
    const group = screen.getByRole('button', { name: 'Edited 1 file +2 −1, ran 1 command, read 1 file' })
    expect(group).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(group)
    expect(screen.getByText('server/agent-resume.ts', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument()
    expect(screen.getByText('Ask before edits')).toBeInTheDocument()
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
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn() }
    render(<ChatPane chat={chat({}, [request])} connected={false} focused={false} {...handlers} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to Commando')
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled()
  })

  it('offers a restart when Commando has updated since the chat started', () => {
    const onRestart = vi.fn()
    render(<ChatPane chat={chat({ updateAvailable: true })} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} onRestart={onRestart} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(onRestart).toHaveBeenCalled()
  })

  it('says when the host is away and disables the composer', () => {
    renderPane(chat({ hostConnected: false }))
    expect(screen.getByRole('status')).toHaveTextContent('disconnected')
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toBeDisabled()
  })
})

const models = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] as const, supportsAutoMode: true },
  { value: 'opus', displayName: 'Opus 5.5', description: 'Most capable', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'max'] as const, supportsAutoMode: true },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Quickest', resolvedModel: 'claude-haiku-5-5', efforts: ['low', 'high'] as const },
].map((model) => ({ ...model, efforts: [...model.efforts] }))

function pickerChat(session: Partial<ChatState['session']> = {}): ChatState {
  const state = chat()
  return { ...state, session: { ...state.session, hostVersion: 2, models, effort: 'high', ...session } }
}

/** Each option's label, ticked ones marked with `*`. */
function optionLabels(menu: HTMLElement): string[] {
  return within(menu).getAllByRole('menuitemradio').map((item) => `${item.getAttribute('aria-checked') === 'true' ? '*' : ''}${item.children[1]?.textContent ?? ''}`)
}

describe('composer pickers', () => {
  it('names the running model and effort, and switches model from the menu', () => {
    const handlers = renderPane(pickerChat())
    fireEvent.click(screen.getByRole('button', { name: 'Opus 5.5 · High' }))
    const menu = screen.getByRole('menu', { name: 'Model' })
    // No explicit pick: the default row is ticked while it is what runs.
    expect(within(menu).getByRole('menuitemradio', { name: /Default \(recommended\)/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Haiku 5.5/ }))
    expect(handlers.onConfigure).toHaveBeenCalledWith({ model: 'haiku' })
  })

  it('offers the efforts of the picked model and switches effort', () => {
    const handlers = renderPane(pickerChat({ selectedModel: 'haiku', model: 'claude-haiku-5-5', effort: 'low' }))
    fireEvent.click(screen.getByRole('button', { name: 'Haiku 5.5 · Low' }))
    const efforts = screen.getByRole('radiogroup', { name: 'Effort' })
    expect(within(efforts).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'High'])
    fireEvent.click(within(efforts).getByRole('radio', { name: 'High' }))
    expect(handlers.onConfigure).toHaveBeenCalledWith({ effort: 'high' })
  })

  it('switches permission mode, offering auto only when the model supports it and bypass only when started with it', () => {
    const handlers = renderPane(pickerChat())
    fireEvent.click(screen.getByRole('button', { name: 'Ask before edits' }))
    const modes = screen.getByRole('menu', { name: 'Permissions' })
    expect(optionLabels(modes)).toEqual(['*Ask before edits', 'Accept edits', 'Plan mode', 'Auto'])
    fireEvent.click(within(modes).getByRole('menuitemradio', { name: /Plan mode/ }))
    expect(handlers.onConfigure).toHaveBeenCalledWith({ permissionMode: 'plan' })
    cleanup()
    renderPane(pickerChat({ selectedModel: 'haiku', model: 'claude-haiku-5-5', permissionMode: 'plan', bypassAllowed: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }))
    expect(optionLabels(screen.getByRole('menu', { name: 'Permissions' }))).toEqual(['Ask before edits', 'Accept edits', '*Plan mode', 'Bypass permissions'])
  })

  it('keeps the pills read-only until Claude lists its models, and disabled while the host is away', () => {
    renderPane(chat())
    expect(screen.queryByRole('button', { name: /claude-opus-5-5/ })).toBeNull()
    cleanup()
    renderPane({ ...pickerChat(), hostConnected: false })
    expect(screen.getByRole('button', { name: 'Opus 5.5 · High' })).toBeDisabled()
    cleanup()
    // A resumed chat replays its history before Claude can switch anything.
    renderPane(pickerChat({ status: 'starting' }))
    expect(screen.getByRole('button', { name: 'Ask before edits' })).toBeDisabled()
  })

  it('keeps the pills read-only for a host that predates the pickers', () => {
    renderPane(pickerChat({ hostVersion: 1 }))
    expect(screen.getByText('Opus 5.5 · High')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Opus 5.5 · High' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ask before edits' })).toBeNull()
    expect(screen.getByTitle('Restart this chat to change its settings')).toHaveTextContent('Ask before edits')
  })
})

describe('context meter', () => {
  const usage = { usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 184_000, autoCompact: true, categories: [{ name: 'Messages', tokens: 54_000 }, { name: 'System tools', tokens: 18_000 }, { name: 'Skills', tokens: 12_000 }] }

  it('shows used and max tokens, the categories and the auto-compact point, and compacts on demand', () => {
    const handlers = renderPane(pickerChat({ contextUsage: usage }))
    fireEvent.click(screen.getByRole('button', { name: 'Context window 42% used' }))
    const popup = screen.getByRole('dialog', { name: 'Context window' })
    expect(popup).toHaveTextContent('84k / 200k · 42%')
    expect(popup).toHaveTextContent('Messages54k')
    expect(popup).toHaveTextContent('Auto-compacts at 92%')
    fireEvent.click(within(popup).getByRole('button', { name: 'Compact now' }))
    expect(handlers.onSend).toHaveBeenCalledWith('/compact')
  })

  it('turns red above 90% and cannot compact mid-turn', () => {
    renderPane(pickerChat({ status: 'running', contextUsage: { ...usage, usedTokens: 190_000 } }))
    const ring = screen.getByRole('button', { name: 'Context window 95% used' })
    expect(ring).toHaveAttribute('data-overloaded', 'true')
    fireEvent.click(ring)
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeDisabled()
  })
})

describe('plan usage meter', () => {
  const now = Date.now()
  const planUsage = {
    plan: 'max',
    updatedAt: now,
    limits: [
      { kind: 'session', title: 'Current session', percent: 38, severity: 'normal' as const, resetsAt: now + 110 * 60_000 },
      { kind: 'weekly_all', title: 'Weekly · all models', percent: 82, severity: 'warning' as const, resetsAt: now + 3 * 86_400_000 },
      { kind: 'weekly_scoped', title: 'Weekly · Fable', percent: 9, severity: 'normal' as const },
    ],
  }

  it('shows the 5h and weekly windows and lists every window with reset times', () => {
    renderPane(pickerChat({ planUsage, configDir: '/home/me/.claudep' }))
    const meter = screen.getByRole('button', { name: 'Plan usage: Current session 38% used, Weekly · all models 82% used' })
    expect(meter).toHaveTextContent('5h38%wk82%')
    fireEvent.click(meter)
    const popup = screen.getByRole('dialog', { name: 'Plan usage' })
    expect(popup).toHaveTextContent('Max · claudep')
    expect(popup).toHaveTextContent('Weekly · Fable9% used')
    expect(popup).toHaveTextContent(/Resets .* · in 1h \d+m/)
    expect(within(popup).getByRole('progressbar', { name: 'Weekly · all models usage' })).toHaveAttribute('aria-valuenow', '82')
  })

  it('swaps the bars for the reset time once a limit is reached', () => {
    renderPane(pickerChat({ planUsage: { ...planUsage, limits: [{ ...planUsage.limits[0]!, percent: 100, severity: 'critical', reached: true }] } }))
    expect(screen.getByRole('button', { name: 'Current session limit reached' })).toHaveTextContent(/^5h limit reached · resets /)
  })

  it('treats a reached window as open again once its reset time has passed', () => {
    renderPane(pickerChat({ planUsage: { ...planUsage, limits: [{ ...planUsage.limits[0]!, percent: 100, severity: 'critical', reached: true, resetsAt: now - 60_000 }] } }))
    const meter = screen.getByRole('button', { name: 'Plan usage: Current session 100% used' })
    fireEvent.click(meter)
    const popup = screen.getByRole('dialog', { name: 'Plan usage' })
    expect(popup).not.toHaveTextContent('Limit reached')
    expect(popup).toHaveTextContent('Reset since this reading')
  })

  it('stays out of the bar without a reading', () => {
    renderPane(pickerChat({}))
    expect(screen.queryByTestId('plan-usage-meter')).toBeNull()
  })
})

describe('thinking rows', () => {
  const thought: ChatItem = { ...base, id: 'th', kind: 'reasoning', text: 'Checking how the hub routes chat_send.', createdAt: 1_000, updatedAt: 15_000 }

  it('labels a thought by how long it took, or not at all when replayed', () => {
    expect(thoughtLabel({ ...thought, kind: 'reasoning' } as Extract<ChatItem, { kind: 'reasoning' }>)).toBe('Thought for 14s')
    expect(thoughtLabel({ ...thought, updatedAt: 1_000 } as Extract<ChatItem, { kind: 'reasoning' }>)).toBe('Thought')
    expect(thoughtLabel({ ...thought, status: 'running' } as Extract<ChatItem, { kind: 'reasoning' }>)).toBe('Thinking…')
  })

  it('folds a thought into a faint line that opens to its summary', () => {
    renderPane(chat({}, [thought]))
    // The trailing thought starts a stretch of its own after the reply.
    const line = screen.getByRole('button', { name: 'Thought · 14s' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Checking how the hub/)).toBeNull()
    // A lone step opens straight to its text.
    fireEvent.click(line)
    expect(screen.getByText('Checking how the hub routes chat_send.')).toBeInTheDocument()
  })

  it('merges thinking between tools into one line that shows what runs now', () => {
    const running: ChatItem = { ...base, id: 'run', status: 'running', kind: 'command', toolUseId: 'r', command: 'npm run typecheck' }
    renderPane(chat({}, [thought, { ...items[2]!, id: 'read2' }, running]))
    expect(screen.queryAllByRole('button', { name: /^Thought/ })).toHaveLength(0)
    expect(screen.getByRole('button', { name: /^npm run typecheck · Read 1 file/ })).toBeInTheDocument()
  })

  it('shows a lone step with nothing to open as plain text, not a disabled button', () => {
    const approval: ChatItem = { ...base, id: 'p', kind: 'request', requestId: 'p', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', answer: { kind: 'approval', decision: 'allow' } }
    renderPane(chat({}, [approval]))
    expect(screen.getByText('Allowed Bash')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Allowed Bash/ })).toBeNull()
  })
})

describe('opened chat task card', () => {
  const parent = { id: '%1', targetId: 'parent', sessionId: '$1' } as TmuxPane
  const child = { id: '%5', targetId: 'child', sessionId: '$2', openedBy: 'parent' } as TmuxPane
  const snapshot = { panes: [parent, child], sessions: [{ id: '$1', name: 'main', attached: true, activeWindowId: null, windowIds: [] }] }
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn() }
  const first = { ...base, id: 'task', kind: 'user_message' as const, text: 'Injected instructions\n---\nThe brief' }
  it('replaces only the first user bubble and jumps to its parent', () => {
    const onSelectPane = vi.fn()
    render(<ChatPane chat={chat({ items: [first, ...items] })} pane={child} snapshot={snapshot} onSelectPane={onSelectPane} connected focused={false} {...handlers} />)
    expect(screen.getByText('Task from main')).toBeInTheDocument()
    expect(screen.getByText('The brief')).toBeInTheDocument()
    expect(screen.queryByText(/Injected instructions/)).not.toBeInTheDocument()
    expect(screen.getByText('Fix the queue')).toHaveClass('bg-message')
    expect(screen.getByText('The brief')).not.toHaveClass('bg-message')
    fireEvent.click(screen.getByRole('button', { name: 'Go to %1' }))
    expect(onSelectPane).toHaveBeenCalledExactlyOnceWith('%1')
  })
  it('has no task card for an ordinary chat', () => {
    render(<ChatPane chat={chat()} pane={{ ...child, openedBy: undefined }} snapshot={snapshot} connected focused={false} {...handlers} />)
    expect(screen.queryByText(/Task from/)).not.toBeInTheDocument()
    expect(screen.getByText('Fix the queue')).toHaveClass('bg-message')
  })
  it('retains the full brief without a separator and hides a vanished parent link', () => {
    render(<ChatPane chat={chat()} pane={child} snapshot={{ ...snapshot, panes: [child] }} connected focused={false} {...handlers} />)
    expect(screen.getByText('Task from another agent')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Go to/ })).not.toBeInTheDocument()
    expect(screen.getByText('Fix the queue')).not.toHaveClass('bg-message')
  })
  it('offers Show more only when the clamped task overflows', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(150)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    try {
      render(<ChatPane chat={chat({ items: [first] })} pane={child} snapshot={snapshot} connected focused={false} {...handlers} />)
      expect(screen.getByText('The brief')).toHaveClass('line-clamp-6')
      fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
      expect(screen.getByText('The brief')).not.toHaveClass('line-clamp-6')
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
      expect(screen.getByText('The brief')).toHaveClass('line-clamp-6')
    } finally { vi.restoreAllMocks() }
  })
})
