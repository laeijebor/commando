// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommanderRelay } from '../../shared/commander'
import type { CommanderInbox, CommanderInboxRow } from '../commanderInbox'
import { AgentsInbox } from './AgentsInbox'

const row = (paneId: string, overrides: Partial<CommanderInboxRow> = {}): CommanderInboxRow => ({ paneId, targetId: `target-${paneId}`, title: `Agent ${paneId}`, sessionName: 'Work', status: 'done', attention: 'review', brief: 'Finished the task', briefTone: 'normal', unread: true, time: Date.now() - 240_000, ...overrides })
const groups = (): CommanderInbox => ({ needs_you: [row('%1', { brief: 'Which option?', briefTone: 'warn', attention: 'needs_input' })], finished: [row('%2')], working: [row('%3', { status: 'working', unread: false, toolCount: 41 })], idle: [row('%4', { unread: false, attention: 'idle' })] })
function setup(data = groups(), disabled = false) {
  const handlers = { onOpenPane: vi.fn(), onRelay: vi.fn() }
  const view = render(<AgentsInbox groups={data} token="token" disabled={disabled} {...handlers} />)
  return { ...handlers, ...view }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AgentsInbox', () => {
  it('renders grouped rows, unread counts, timing, and initially collapsed idle agents', () => {
    setup()
    expect(screen.getByRole('button', { name: /Agents · 2 new · 1 working · 1 idle/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: 'Needs you' })).toHaveTextContent('Which option?')
    expect(screen.getByRole('group', { name: 'Finished a turn' })).toBeInTheDocument()
    expect(screen.getAllByLabelText('Unread')).toHaveLength(2)
    expect(screen.getByText('41 tools · 4m')).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Agent %4' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Idle · 1/ }))
    expect(screen.getByRole('option', { name: 'Agent %4' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Agents · 2 new/ }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('uses roving focus, opens by Enter/click and cancels replies with Escape', () => {
    const { onOpenPane } = setup()
    const first = screen.getByRole('option', { name: 'Agent %1' })
    const second = screen.getByRole('option', { name: 'Agent %2' })
    expect(first).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    expect(second).toHaveAttribute('tabindex', '0')
    expect(first).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(second, { key: 'Enter' })
    expect(onOpenPane).toHaveBeenLastCalledWith('%2', 'target-%2')
    fireEvent.keyDown(second, { key: 'r' })
    const reply = screen.getByRole('textbox', { name: 'Reply to Agent %2' })
    expect(reply).toHaveFocus()
    fireEvent.keyDown(reply, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(first).toHaveFocus()
    fireEvent.click(first)
    expect(onOpenPane).toHaveBeenLastCalledWith('%1', 'target-%1')
  })
  it('queues an inline reply without opening the pane and shows the returned receipt', async () => {
    const relay = { id: 'r', toPaneId: '%1', toTargetId: 'target-%1', createdAt: Date.now(), status: 'queued' } as CommanderRelay
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true, relay }))
    const { onOpenPane, onRelay, rerender } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Agent %1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply to Agent %1' }), { target: { value: '  Use option A  ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(onRelay).toHaveBeenCalledWith(relay))
    expect(fetcher).toHaveBeenCalledWith('/api/commander/relays', expect.objectContaining({ body: JSON.stringify({ paneId: '%1', text: 'Use option A', delivery: 'queue' }), credentials: 'same-origin', headers: expect.objectContaining({ Authorization: 'Bearer token' }) }))
    expect(onOpenPane).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
    const next = groups()
    next.needs_you[0].latestRelay = relay
    rerender(<AgentsInbox groups={next} token="token" onOpenPane={onOpenPane} onRelay={onRelay} />)
    expect(screen.getByText('Relayed · queued')).toBeInTheDocument()
    next.needs_you[0].latestRelay = { ...relay, status: 'delivered' }
    rerender(<AgentsInbox groups={{ ...next }} token="token" onOpenPane={onOpenPane} onRelay={onRelay} />)
    expect(screen.getByText('Relayed · delivered')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Agent %1' }))
    expect(onOpenPane).toHaveBeenCalledTimes(1)
  })
  it('keeps a failed reply editable and displays an inline error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Agent is unavailable' }, { status: 409 }))
    const { onRelay } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Agent %1' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Try again' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent is unavailable')
    expect(screen.getByRole('textbox')).toHaveValue('Try again')
    expect(onRelay).not.toHaveBeenCalled()
  })
  it('shows failed receipts, omits expired ones, and disables offline replies', () => {
    const data = groups()
    data.finished[0].latestRelay = { id: 'r', status: 'failed', error: 'Pane closed', createdAt: Date.now() } as CommanderRelay
    data.working[0].latestRelay = { id: 'old', status: 'delivered', createdAt: Date.now() - 16 * 60_000 } as CommanderRelay
    setup(data, true)
    expect(screen.getByText('Relay failed: Pane closed')).toBeInTheDocument()
    expect(screen.queryByText('Relayed · delivered')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reply to Agent %1' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('option', { name: 'Agent %1' }), { key: 'r' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
  it('keeps a usable focus target when the selected pane disappears or idle is collapsed', () => {
    const { onOpenPane, onRelay, rerender } = setup()
    fireEvent.keyDown(screen.getByRole('option', { name: 'Agent %1' }), { key: 'ArrowDown' })
    const data = groups()
    data.finished = []
    rerender(<AgentsInbox groups={data} token="token" onOpenPane={onOpenPane} onRelay={onRelay} />)
    expect(screen.getByRole('option', { name: 'Agent %1' })).toHaveAttribute('tabindex', '0')
    fireEvent.click(screen.getByRole('button', { name: /Idle · 1/ }))
    fireEvent.focus(screen.getByRole('option', { name: 'Agent %4' }))
    fireEvent.click(screen.getByRole('button', { name: /Idle · 1/ }))
    expect(screen.getByRole('option', { name: 'Agent %1' })).toHaveAttribute('tabindex', '0')
  })
  it('renders an empty directory', () => {
    setup({ needs_you: [], finished: [], working: [], idle: [] })
    expect(within(screen.getByRole('listbox')).getByText('No other agents yet.')).toBeInTheDocument()
  })
})

it('sends only once when Enter is pressed twice before fetch resolves', async () => {
  let resolve!: (response: Response) => void
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((r) => { resolve = r }))
  const { onRelay } = setup()
  fireEvent.click(screen.getByRole('button', { name: 'Reply to Agent %1' }))
  const textbox = screen.getByRole('textbox')
  fireEvent.change(textbox, { target: { value: 'Use A' } })
  fireEvent.keyDown(textbox, { key: 'Enter' }); fireEvent.keyDown(textbox, { key: 'Enter' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  const relay = { id: 'one', status: 'queued' } as CommanderRelay
  resolve(Response.json({ ok: true, relay }))
  await waitFor(() => expect(onRelay).toHaveBeenCalledExactlyOnceWith(relay))
})
it('keeps queued receipts visible past fifteen minutes', () => {
  const data = groups()
  data.finished[0].latestRelay = { status: 'queued', createdAt: Date.now() - 60 * 60_000 } as CommanderRelay
  setup(data)
  expect(screen.getByText('Relayed · queued')).toBeInTheDocument()
})
