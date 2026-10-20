// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommanderInboxRow } from '../commanderInbox'
import { CommanderSplit, CommanderTranscriptView, type CommanderPeek } from './CommanderReadingPane'

const row: CommanderInboxRow = { paneId: '%5', targetId: 'target-5', title: 'Fix login', sessionName: 'Auth', status: 'done', attention: 'review', briefTone: 'normal', unread: true, time: 0 }
const peek = (overrides: Partial<CommanderPeek> = {}): CommanderPeek => ({ row, group: 'finished', view: <p>Agent chat</p>, onClose: vi.fn(), onOpen: vi.fn(), onStep: vi.fn(), ...overrides })
const width = (value: number) => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: value } as DOMRect)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('CommanderSplit', () => {
  it('puts the reading pane beside Commander when wide, and over it when narrow', () => {
    width(1200)
    const split = render(<CommanderSplit peek={peek()}><p>Commander chat</p></CommanderSplit>)
    expect(screen.getByTestId('commander-split')).toHaveAttribute('data-mode', 'split')
    expect(screen.getByText('Commander chat')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back to Commander' })).toBeNull()
    split.unmount()
    width(700)
    const onClose = vi.fn()
    render(<CommanderSplit peek={peek({ onClose })}><p>Commander chat</p></CommanderSplit>)
    expect(screen.getByTestId('commander-split')).toHaveAttribute('data-mode', 'full')
    expect(screen.getByText('Commander chat').parentElement).toHaveClass('hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Back to Commander' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('steps, opens the session, and closes on Esc unless a draft or inner view used it', () => {
    width(1200)
    const props = peek({ view: <><textarea aria-label="Draft" defaultValue="half-typed" /><button type="button" onKeyDown={(event) => event.preventDefault()}>Inner</button></> })
    render(<CommanderSplit peek={props}><p>Commander chat</p></CommanderSplit>)
    expect(screen.getByRole('region', { name: 'Fix login chat' })).toHaveTextContent('Fix login')
    fireEvent.click(screen.getByRole('button', { name: 'Next agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous agent' }))
    expect(props.onStep).toHaveBeenNthCalledWith(1, 1)
    expect(props.onStep).toHaveBeenNthCalledWith(2, -1)
    fireEvent.click(screen.getByRole('button', { name: /Open in session/ }))
    expect(props.onOpen).toHaveBeenCalledOnce()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Draft' }), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inner' }), { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Next agent' }), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
  })
  it('renders nothing extra while closed', () => {
    render(<CommanderSplit><p>Commander chat</p></CommanderSplit>)
    expect(screen.getByTestId('commander-split')).toHaveAttribute('data-mode', 'closed')
    expect(screen.queryByTestId('commander-reading-pane')).toBeNull()
  })
})

describe('CommanderTranscriptView', () => {
  const respond = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  it('shows the transcript, refreshes when the turn changes, and relays a message', async () => {
    const fetcher = respond({ ok: true, source: 'transcript', items: [
      { id: 'u', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'user_message', text: 'Fix the login bug' },
      { id: 'a', turnId: 't', status: 'completed', createdAt: 1, updatedAt: 1, kind: 'assistant_message', text: 'Fixed the login bug.' },
    ] })
    vi.stubGlobal('fetch', fetcher)
    const onRelay = vi.fn()
    const view = render(<CommanderTranscriptView token="t" row={row} provider="claude" cwd="/repo" refreshKey="done:1" onRelay={onRelay} />)
    expect(await screen.findByText('Fixed the login bug.')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledWith('/api/commander/transcript?pane=%255', expect.objectContaining({ method: 'GET' }))
    view.rerender(<CommanderTranscriptView token="t" row={row} provider="claude" cwd="/repo" refreshKey="done:2" onRelay={onRelay} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const relay = { id: 'r1', status: 'queued' }
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true, relay }), { status: 200 }))
    const box = screen.getByRole('textbox', { name: 'Message Fix login' })
    fireEvent.change(box, { target: { value: 'Also add a test' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onRelay).toHaveBeenCalledWith(relay))
    expect(fetcher).toHaveBeenLastCalledWith('/api/commander/relays', expect.objectContaining({ body: JSON.stringify({ paneId: '%5', text: 'Also add a test', delivery: 'queue' }) }))
    expect(box).toHaveValue('')
  })
  it('falls back to the pane screen and reports read errors', async () => {
    vi.stubGlobal('fetch', respond({ ok: true, source: 'screen', items: [], screen: '$ npm test\nok' }))
    const view = render(<CommanderTranscriptView token="t" row={row} provider="codex" cwd="/repo" refreshKey="a" onRelay={vi.fn()} />)
    expect(await screen.findByText(/npm test/)).toBeInTheDocument()
    expect(screen.getByText(/No transcript found/)).toBeInTheDocument()
    view.unmount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Agent pane does not exist' }), { status: 404 })))
    render(<CommanderTranscriptView token="t" row={row} provider="codex" cwd="/repo" refreshKey="b" onRelay={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent pane does not exist')
  })
})
