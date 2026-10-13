// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PLAN_IMPLEMENTATION_PREFIX, type ChatItem, type ChatSessionInfo, type ChatState } from '../../shared/agent-chat'
import { ChatPane, type ChatFlowServices } from './ChatPane'
import { readDraft } from './draftStore'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const base = { turnId: 't1', status: 'completed' as const, createdAt: 1, updatedAt: 1 }
const PLAN = '# Add greeting.txt\n\n- Create it\n- Check it'

function session(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return { paneId: '%5', provider: 'claude', cwd: '/work', status: 'idle', hostPid: 1, hostVersion: 4, permissionMode: 'plan', configDir: '/Users/me/.claudep', ...overrides }
}

function flowServices(overrides: Partial<ChatFlowServices> = {}): ChatFlowServices {
  return {
    queue: vi.fn(),
    task: vi.fn(),
    subagentTranscript: vi.fn(async () => ({ items: [] })),
    savePlan: vi.fn(async () => ({ path: '/Users/me/.commando/notes-vaults/default/Plans/add-greeting-txt--1.md' })),
    implementInNewPane: vi.fn(async () => undefined),
    ...overrides,
  }
}

function renderPane(items: ChatItem[], sessionOverrides: Partial<ChatSessionInfo> = {}, flow: ChatFlowServices | null = flowServices()) {
  const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn() }
  const state: ChatState = { paneId: '%5', session: session(sessionOverrides), items, hostConnected: true }
  const view = render(<ChatPane chat={state} connected focused={false} {...handlers} {...(flow ? { flow } : {})} />)
  const rerender = (nextItems: ChatItem[], nextSession: Partial<ChatSessionInfo> = sessionOverrides) => {
    view.rerender(<ChatPane chat={{ ...state, items: nextItems, session: session(nextSession) }} connected focused={false} {...handlers} {...(flow ? { flow } : {})} />)
  }
  return { ...handlers, flow, rerender }
}

const textbox = () => screen.getByRole('textbox', { name: 'Message Claude' })
const planItems: ChatItem[] = [
  { ...base, id: 'u1', kind: 'user_message', text: 'Plan a greeting file' },
  { ...base, id: 'plan-tu1', kind: 'plan', toolUseId: 'tu1', text: PLAN },
]

describe('plan cards', () => {
  it('shows the plan with Copy and Save to vault, and says where it was saved', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { flow } = renderPane(planItems)
    const card = screen.getByTestId('plan-card')
    expect(within(card).getByText('Add greeting.txt')).toBeInTheDocument()
    expect(within(card).getByText('Create it')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Copy plan' }))
    expect(writeText).toHaveBeenCalledWith(`${PLAN}\n`)
    fireEvent.click(within(card).getByRole('button', { name: /Save to vault/ }))
    expect(flow!.savePlan).toHaveBeenCalledWith(PLAN)
    expect(await within(card).findByText('~/.commando/notes-vaults/default/Plans/add-greeting-txt--1.md')).toBeInTheDocument()
  })

  it('reports a failed save and folds a long plan', async () => {
    const long = ['# Long', ...Array.from({ length: 30 }, (_, index) => `- step ${index}`)].join('\n')
    renderPane([{ ...base, id: 'plan-tu2', kind: 'plan', toolUseId: 'tu2', text: long }], {}, flowServices({ savePlan: vi.fn(async () => { throw new Error('Vault directory is unavailable') }) }))
    expect(screen.queryByText('step 20')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Expand plan' }))
    expect(screen.getByText('step 20')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Save to vault/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Vault directory is unavailable')
  })
})

describe('plan follow-up', () => {
  it('implements in the pre-plan mode when the draft is empty', () => {
    const { onSend } = renderPane(planItems, { prePlanPermissionMode: 'acceptEdits' })
    expect(screen.getByTestId('plan-ready')).toHaveTextContent('Implement switches to Accept edits')
    fireEvent.click(screen.getByTestId('plan-implement'))
    expect(onSend).toHaveBeenCalledWith(`${PLAN_IMPLEMENTATION_PREFIX}${PLAN}`, undefined, { permissionMode: 'acceptEdits' })
  })

  it('refines in plan mode once something is typed', () => {
    const { onSend } = renderPane(planItems)
    fireEvent.change(textbox(), { target: { value: 'Use a .md file instead' } })
    expect(screen.queryByTestId('plan-implement')).not.toBeInTheDocument()
    expect(screen.getByTestId('plan-ready')).toHaveTextContent('Claude stays in plan mode')
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }))
    expect(onSend).toHaveBeenCalledWith('Use a .md file instead')
  })

  it('implements in a new chat pane, and reports when that fails', async () => {
    const flow = flowServices({ implementInNewPane: vi.fn(async () => { throw new Error('tmux refused') }) })
    renderPane(planItems, {}, flow)
    fireEvent.click(screen.getByRole('button', { name: 'More ways to implement' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Implement in a new chat pane' }))
    expect(flow.implementInNewPane).toHaveBeenCalledWith(PLAN, 'default')
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start a new chat pane: tmux refused")
  })

  it('offers nothing once the plan has been answered or while Claude works', () => {
    const { rerender } = renderPane([...planItems, { ...base, id: 'u2', kind: 'user_message', text: 'go' }])
    expect(screen.queryByTestId('plan-ready')).not.toBeInTheDocument()
    rerender(planItems, { status: 'running' })
    expect(screen.queryByTestId('plan-ready')).not.toBeInTheDocument()
  })
})

describe('queue and steer', () => {
  it('queues on Enter and steers on ⌘Enter or the steer button while Claude works', () => {
    const { onSend } = renderPane([], { status: 'running' })
    fireEvent.change(textbox(), { target: { value: 'then run lint' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('then run lint', [], { delivery: 'queue' })
    fireEvent.change(textbox(), { target: { value: 'stop, use pnpm' } })
    fireEvent.keyDown(textbox(), { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenLastCalledWith('stop, use pnpm', [], { delivery: 'steer' })
    fireEvent.change(textbox(), { target: { value: 'and now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }))
    expect(onSend).toHaveBeenLastCalledWith('and now', [], { delivery: 'steer' })
  })

  it('sends plainly when idle, and to an older host', () => {
    const { onSend, rerender } = renderPane([])
    fireEvent.change(textbox(), { target: { value: 'hello' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('hello')
    rerender([], { status: 'running', hostVersion: 3 })
    expect(screen.queryByRole('button', { name: 'Steer now' })).not.toBeInTheDocument()
    fireEvent.change(textbox(), { target: { value: 'fold me in' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('fold me in')
  })

  it('edits, removes and steers queued messages', () => {
    const { flow } = renderPane([], { status: 'running', queue: [{ id: 'q1', text: 'run lint' }, { id: 'q2', text: 'and the tests' }] })
    const queue = screen.getByTestId('chat-queue')
    expect(within(queue).getByText('run lint')).toBeInTheDocument()
    fireEvent.click(within(queue).getAllByRole('button', { name: 'Edit queued message' })[0]!)
    fireEvent.change(within(queue).getByRole('textbox', { name: 'Edit queued message' }), { target: { value: 'run lint --fix' } })
    fireEvent.click(within(queue).getByRole('button', { name: 'Save' }))
    expect(flow!.queue).toHaveBeenCalledWith({ action: 'edit', id: 'q1', text: 'run lint --fix' })
    fireEvent.click(within(queue).getAllByRole('button', { name: 'Remove queued message' })[1]!)
    expect(flow!.queue).toHaveBeenCalledWith({ action: 'remove', id: 'q2' })
    fireEvent.click(within(queue).getAllByRole('button', { name: /Steer now/ })[0]!)
    expect(flow!.queue).toHaveBeenCalledWith({ action: 'steer', id: 'q1' })
  })

  it('brings queued messages back into the composer on Stop', () => {
    const { onInterrupt } = renderPane([], { sessionId: 'queue-session', status: 'running', queue: [{ id: 'q1', text: 'run lint' }, { id: 'q2', text: 'and the tests' }] })
    fireEvent.change(textbox(), { target: { value: 'half typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onInterrupt).toHaveBeenCalledWith(['q1', 'q2'])
    expect(textbox()).toHaveValue('run lint\n\nand the tests\n\nhalf typed')
    act(() => { window.dispatchEvent(new Event('pagehide')) })
    expect(readDraft('queue-session')).toBe('run lint\n\nand the tests\n\nhalf typed')
  })
})

const agentItem = (id: string, overrides: Record<string, unknown> = {}): ChatItem => ({
  ...base, id, kind: 'subagent', toolUseId: id, description: `job ${id}`, subagentType: 'general-purpose', agentId: `a${id}`, state: 'completed', ...overrides,
} as ChatItem)

describe('subagents', () => {
  const live: ChatItem[] = [
    { ...base, id: 'u1', kind: 'user_message', text: 'Use two subagents' },
    agentItem('t1', { state: 'running', status: 'running', prompt: 'Count the files', toolUses: 2, summary: 'Running ls' }),
    { ...base, id: 'c1', kind: 'command', toolUseId: 'c1', command: 'ls', output: 'a b', parentToolUseId: 't1' },
    { ...base, id: 'm1', kind: 'assistant_message', text: 'Two files so far', parentToolUseId: 't1' },
    agentItem('t2', { output: 'Sun 11 Oct' }),
  ]

  it('groups them, opens one live, and goes back to main', () => {
    renderPane(live)
    const group = screen.getByTestId('subagent-group')
    expect(group).toHaveTextContent('2 subagents · 1 running')
    expect(group).toHaveTextContent('Running ls')
    expect(screen.queryByText('Two files so far')).not.toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: 'Open subagent job t1' }))
    expect(screen.getByTestId('subagent-header')).toHaveTextContent('job t1')
    expect(screen.getByText('Count the files')).toBeInTheDocument()
    expect(screen.getByText('Two files so far')).toBeInTheDocument()
    expect(screen.queryByText('Use two subagents')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to main' }))
    expect(screen.getByText('Use two subagents')).toBeInTheDocument()
  })

  it('reads a subagent with no live items from its saved transcript', async () => {
    const flow = flowServices({
      subagentTranscript: vi.fn(async () => ({ items: [{ ...base, id: 'x1', kind: 'user_message' as const, text: 'Run date' }, { ...base, id: 'x2', kind: 'assistant_message' as const, text: 'It is Sunday.' }] })),
    })
    renderPane(live, {}, flow)
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent job t2' }))
    expect(flow.subagentTranscript).toHaveBeenCalledWith('at2')
    expect(await screen.findByText('It is Sunday.')).toBeInTheDocument()
  })

  it('shows a transcript error and the final report when nothing was saved', async () => {
    renderPane(live, {}, flowServices({ subagentTranscript: vi.fn(async () => ({ items: [], error: "Claude Code hasn't saved this subagent's transcript" })) }))
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent job t2' }))
    expect(await screen.findByText("Claude Code hasn't saved this subagent's transcript")).toBeInTheDocument()
    expect(screen.getByText('Sun 11 Oct')).toBeInTheDocument()
  })

  it('switches agents from the list with the arrow keys and Enter', () => {
    renderPane(live)
    const switcher = screen.getByTestId('agent-switcher')
    const options = within(switcher).getAllByRole('option')
    expect(options.map((option) => option.textContent?.split('general-purpose')[0])).toEqual(['Main', 'job t1', 'job t2'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    act(() => options[0]!.focus())
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' })
    fireEvent.keyDown(within(switcher).getAllByRole('option')[1]!, { key: 'Enter' })
    expect(screen.getByTestId('subagent-header')).toHaveTextContent('job t1')
    expect(within(screen.getByTestId('agent-switcher')).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('stops and backgrounds a running subagent', () => {
    const { flow } = renderPane(live)
    const switcher = screen.getByTestId('agent-switcher')
    fireEvent.click(within(switcher).getByRole('button', { name: 'Background job t1' }))
    expect(flow!.task).toHaveBeenCalledWith('background', 'at1', 't1')
    fireEvent.click(within(switcher).getByRole('button', { name: 'Stop job t1' }))
    expect(flow!.task).toHaveBeenCalledWith('stop', 'at1', 't1')
    expect(within(switcher).queryByRole('button', { name: 'Stop job t2' })).not.toBeInTheDocument()
  })

  it('relays a message to a background subagent through main Claude', () => {
    const items = live.map((item) => (item.id === 't1' ? { ...item, background: true } as ChatItem : item))
    const { onSend } = renderPane(items, { status: 'running' })
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent job t1' }))
    fireEvent.click(within(screen.getByTestId('subagent-header')).getByRole('button', { name: 'Message' }))
    expect(screen.getByTestId('relay-chip')).toHaveTextContent('relayed through main Claude')
    fireEvent.change(textbox(), { target: { value: 'The fruit is MANGO.' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    expect(onSend).toHaveBeenLastCalledWith('The fruit is MANGO.', [], { relayTo: { agentId: 'at1', label: 'job t1' } })
  })

  it("won't relay to a foreground subagent that holds main Claude", () => {
    renderPane(live)
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent job t1' }))
    const message = within(screen.getByTestId('subagent-header')).getByRole('button', { name: 'Message' })
    expect(message).toBeDisabled()
    expect(message).toHaveAttribute('title', expect.stringContaining('Background this subagent'))
  })

  it('labels relayed and steered messages in the timeline', () => {
    renderPane([
      { ...base, id: 'u1', kind: 'user_message', text: 'MANGO', relayTo: { agentId: 'at1', label: 'fruit waiter' } },
      { ...base, id: 'u2', kind: 'user_message', text: 'use pnpm', steered: true },
      { ...base, id: 'u3', kind: 'user_message', text: `${PLAN_IMPLEMENTATION_PREFIX}${PLAN}` },
    ])
    expect(screen.getByText('To @fruit waiter, relayed through main Claude')).toBeInTheDocument()
    expect(screen.getByText('Steered: sent while Claude worked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Implement the plan: Add greeting.txt/ })).toBeInTheDocument()
  })

  it('waits for the switcher until a subagent exists, and needs flow services for it', async () => {
    const { rerender } = renderPane([{ ...base, id: 'u1', kind: 'user_message', text: 'hi' }])
    expect(screen.queryByTestId('agent-switcher')).not.toBeInTheDocument()
    rerender(live)
    await waitFor(() => expect(screen.getByTestId('agent-switcher')).toBeInTheDocument())
    cleanup()
    renderPane(live, {}, null)
    expect(screen.queryByTestId('agent-switcher')).not.toBeInTheDocument()
  })
})

describe('review fixes', () => {
  it('moves an edit into the composer when its queued message is sent meanwhile', () => {
    const { rerender } = renderPane([], { status: 'running', queue: [{ id: 'q1', text: 'run lint' }, { id: 'q2', text: 'keep' }] })
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit queued message' }), { target: { value: 'run lint --fix' } })
    rerender([], { status: 'running', queue: [{ id: 'q2', text: 'keep' }] })
    expect(textbox()).toHaveValue('run lint --fix')
    expect(screen.getByRole('alert')).toHaveTextContent('your edit is in the composer')
  })

  it('keeps queued messages whose images would not fit when Stop brings the queue back', () => {
    const images = (prefix: string) => Array.from({ length: 6 }, (_, index) => ({ id: `${prefix.repeat(63)}${index}.png` }))
    const { onInterrupt } = renderPane([], { status: 'running', queue: [{ id: 'q1', text: 'first', images: images('a') }, { id: 'q2', text: 'second', images: images('b') }] })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onInterrupt).toHaveBeenCalledWith(['q1'])
    expect(textbox()).toHaveValue('first')
    expect(screen.getByRole('alert')).toHaveTextContent('stays queued')
  })

  it('implements once, and offers the plan again if Implement failed', () => {
    const { onSend, rerender } = renderPane(planItems, { prePlanPermissionMode: 'acceptEdits' })
    fireEvent.click(screen.getByTestId('plan-implement'))
    expect(screen.queryByTestId('plan-implement')).not.toBeInTheDocument()
    expect(onSend).toHaveBeenCalledTimes(1)
    rerender([...planItems, { ...base, id: 'n1', kind: 'notice', level: 'error', text: "Couldn't change the permission mode" }], { prePlanPermissionMode: 'acceptEdits' })
    expect(screen.getByTestId('plan-implement')).toBeInTheDocument()
  })

  it('shows a refused action without putting an old message back in the draft', () => {
    const handlers = { onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn(), onDismissActionError: vi.fn() }
    const state: ChatState = { paneId: '%5', session: session(), items: [], hostConnected: true }
    const view = render(<ChatPane chat={state} connected focused={false} {...handlers} flow={flowServices()} />)
    fireEvent.change(textbox(), { target: { value: 'sent earlier' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    view.rerender(<ChatPane chat={state} connected focused={false} {...handlers} flow={flowServices()} actionError="This chat started before queueing" />)
    expect(screen.getByRole('alert')).toHaveTextContent('This chat started before queueing')
    expect(textbox()).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(handlers.onDismissActionError).toHaveBeenCalled()
  })

  it('offers Retry when a subagent transcript fails to load', async () => {
    const subagentTranscript = vi.fn()
      .mockResolvedValueOnce({ items: [], error: 'Reading the transcript timed out' })
      .mockResolvedValueOnce({ items: [{ ...base, id: 'x2', kind: 'assistant_message' as const, text: 'Loaded now' }] })
    renderPane([agentItem('t2')], {}, flowServices({ subagentTranscript }))
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent job t2' }))
    expect(await screen.findByText('Reading the transcript timed out')).toBeInTheDocument()
    expect(screen.queryByText('This subagent left no transcript.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Loaded now')).toBeInTheDocument()
  })

  it('says so when the page cannot use the clipboard', () => {
    Object.assign(navigator, { clipboard: undefined })
    renderPane(planItems)
    fireEvent.click(screen.getByRole('button', { name: 'Copy plan' }))
    expect(screen.getByRole('alert')).toHaveTextContent("can't use the clipboard")
  })
})

describe('refused queued and steered sends', () => {
  it('puts a queued or steered send back in the draft when the daemon refuses it', () => {
    const handlers = { onSend: vi.fn().mockReturnValueOnce('req-queue').mockReturnValueOnce('req-steer'), onInterrupt: vi.fn(), onAnswer: vi.fn(), onFocus: vi.fn(), onConfigure: vi.fn() }
    const state: ChatState = { paneId: '%5', session: session({ status: 'running' }), items: [], hostConnected: true }
    const view = render(<ChatPane chat={state} connected focused={false} {...handlers} flow={flowServices()} />)
    fireEvent.change(textbox(), { target: { value: 'queued one' } })
    fireEvent.keyDown(textbox(), { key: 'Enter' })
    fireEvent.change(textbox(), { target: { value: 'steered one' } })
    fireEvent.keyDown(textbox(), { key: 'Enter', metaKey: true })
    expect(handlers.onSend.mock.calls.map((call) => call[2])).toEqual([{ delivery: 'queue' }, { delivery: 'steer' }])
    view.rerender(<ChatPane chat={state} connected focused={false} {...handlers} flow={flowServices()} sendError={{ message: 'This chat started before queueing and steering', refused: [{ requestId: 'req-queue' }, { requestId: 'req-steer' }] }} />)
    expect(textbox()).toHaveValue('queued one\n\nsteered one')
    expect(screen.getByRole('alert')).toHaveTextContent('This chat started before queueing')
  })
})
