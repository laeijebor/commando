// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatState, ExternalAgentRun } from '../../shared/agent-chat'
import { withExternalAgentRuns } from '../../shared/chat-timeline'
import { ChatPane, type ChatFlowServices } from './ChatPane'
import { relayAvailability, subagentActivity, subagentTypeLabel, switcherSubagents } from './turnFlow'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })
const now = Date.now()
const run: ExternalAgentRun = { id: 'external-1', runtime: 'codex', label: 'Review tests', state: 'running', startedAt: now - 10_000, updatedAt: now, model: 'gpt-6.1-sol', effort: 'high', toolUses: 2, lastAction: '$ git diff' }
const chat: ChatState = {
  paneId: '%5', hostConnected: true,
  session: { paneId: '%5', provider: 'claude', hostPid: 20, hostVersion: 4, cwd: '/work', status: 'idle' },
  items: [{ id: 'launch', kind: 'command', toolUseId: 'launch', turnId: 't1', command: 'codex exec prompt &', status: 'completed', createdAt: now - 11_000, updatedAt: now - 11_000 }],
}
function show(runs: ExternalAgentRun[], overrides: Partial<ChatState> = {}) {
  const flow: ChatFlowServices = { queue: vi.fn(), task: vi.fn(), stopExternal: vi.fn(), subagentTranscript: vi.fn(async () => ({ items: [] })), savePlan: vi.fn(async () => ({ path: '/plan.md' })) }
  render(<ChatPane chat={{ ...chat, ...overrides }} externalRuns={runs} connected focused={false} onFocus={vi.fn()} onSend={vi.fn()} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} flow={flow} />)
  return flow
}

describe('external runs in chat', () => {
  it('renders runtime/model/effort and progress, offers Stop in both surfaces and never opens a transcript', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const flow = show([run])
    const group = screen.getByTestId('subagent-group')
    expect(group).toHaveTextContent('Codex · gpt-6.1-sol high')
    expect(group).toHaveTextContent('2 tools · 10s · $ git diff')
    const row = within(group).getByRole('button', { name: 'Open subagent Review tests' })
    expect(row).toBeDisabled()
    fireEvent.click(row)
    const switcher = screen.getByTestId('agent-switcher')
    const option = within(switcher).getByRole('option', { name: /Review tests/ })
    expect(option).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(option)
    fireEvent.keyDown(option, { key: 'Enter' })
    expect(screen.queryByTestId('subagent-header')).not.toBeInTheDocument()
    expect(flow.subagentTranscript).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Background/ })).not.toBeInTheDocument()
    fireEvent.click(within(group).getByRole('button', { name: 'Stop Review tests' }))
    const stop = within(switcher).getByRole('button', { name: 'Stop Review tests' })
    expect(fireEvent.keyDown(stop, { key: 'Enter' })).toBe(true)
    fireEvent.click(stop)
    expect(flow.stopExternal).toHaveBeenNthCalledWith(1, 'external-1')
    expect(flow.stopExternal).toHaveBeenNthCalledWith(2, 'external-1')
    expect(flow.task).not.toHaveBeenCalled()
  })

  it('shows quiet in warning colors and offers Stop even when the host is disconnected', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    show([{ ...run, state: 'quiet', toolUses: 21, startedAt: now - 1_083_000, lastEventAt: now - 420_000 }], { hostConnected: false })
    const group = screen.getByTestId('subagent-group')
    expect(within(group).getByLabelText('Quiet')).toHaveClass('text-warning')
    expect(group).toHaveTextContent('21 tools · 18m 03s · quiet for 7m · last: $ git diff')
    expect(within(group).getByText('quiet for 7m')).toHaveClass('text-warning')
    expect(within(group).getByText('21 tools · 18m 03s')).not.toHaveClass('text-warning')
    expect(within(group).getByText('quiet for 7m').parentElement).not.toHaveClass('text-warning')
    const switcher = screen.getByTestId('agent-switcher')
    expect(switcher).toHaveTextContent('21 tools · 18m 03s · quiet for 7m · last: $ git diff')
    expect(within(switcher).getByText('quiet for 7m')).toHaveClass('text-warning')
    expect(within(switcher).getByText('quiet for 7m').parentElement).not.toHaveClass('text-warning')
    expect(within(group).getByRole('button', { name: 'Stop Review tests' })).toBeEnabled()
    expect(within(screen.getByTestId('agent-switcher')).getByRole('button', { name: 'Stop Review tests' })).toBeEnabled()
  })

  it('shows a live descendant command and its elapsed time instead of the last action', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    show([{ ...run, toolUses: 9, startedAt: now - 192_000, runningCommand: { command: 'npm test', startedAt: now - 125_000 } }])
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('9 tools · 3m 12s · running npm test (2m 05s)')
    expect(screen.getByTestId('agent-switcher')).toHaveTextContent('9 tools · 3m 12s · running npm test (2m 05s)')
    expect(screen.getByTestId('subagent-group')).not.toHaveTextContent('$ git diff')
  })

  it('omits unknown tool counts for liveness-only runtimes, retaining elapsed time and activity', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    show([{ ...run, runtime: 'opencode', toolUses: undefined, runningCommand: { command: 'npm test', startedAt: now - 5_000 } }])
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('10s · running npm test (5s)')
    expect(screen.getByTestId('subagent-group')).not.toHaveTextContent('tools')
  })

  it('keeps finished rows without Stop and supports old hosts without SDK subagent controls', () => {
    show([{ ...run, state: 'completed', finishedAt: now }], { session: { ...chat.session, hostVersion: 3 } })
    expect(screen.getByTestId('subagent-group')).toHaveTextContent('Review tests')
    expect(screen.queryByRole('button', { name: 'Stop Review tests' })).not.toBeInTheDocument()
  })

  it('includes running and quiet external agents from earlier turns and reports relay unavailable', () => {
    const items = withExternalAgentRuns(chat.items, [run, { ...run, id: 'external-quiet', state: 'quiet', runtime: 'cursor' }])
    items.push({ id: 'sdk', kind: 'subagent', toolUseId: 'sdk', description: 'SDK task', turnId: 't2', state: 'completed', status: 'completed', createdAt: now, updatedAt: now })
    const agents = switcherSubagents(items)
    expect(agents.map((agent) => agent.id)).toEqual(['external-1', 'external-quiet', 'sdk'])
    expect(relayAvailability(agents[0]!)).toMatchObject({ ok: false })
    expect(subagentTypeLabel(agents[0]!)).toBe('Codex · gpt-6.1-sol high')
    expect(subagentTypeLabel(agents[1]!)).toBe('Cursor · gpt-6.1-sol high')
    expect(subagentActivity(agents[1]!, items, now)).toMatchObject({ elapsedMs: 10_000, lastAction: '$ git diff' })
  })
})
