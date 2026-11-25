// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asideKey, type ChatAsideRecord, type ChatState } from '../../shared/agent-chat'
import { ChatPane, type ChatAsideServices, type ChatThreadBindings } from './ChatPane'
import { AsideTabs, AsideBanner } from './AsideTabs'
import { ChatComposer } from './ChatComposer'
import { ChatStashContext, type ChatStash } from './chatStash'

const record: ChatAsideRecord = { id: 'abcdefgh', title: 'Why flaky?', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main' }, createdAt: Date.now(), status: 'open' }
const main: ChatState = { paneId: '%5', hostConnected: true, asides: [record], session: { paneId: '%5', sessionId: 'main', provider: 'claude', cwd: '/work', status: 'running', hostPid: 1, hostVersion: 10 }, items: [{ id: 'main-message', turnId: 't', kind: 'assistant_message', text: 'Main answer', status: 'completed', createdAt: 1, updatedAt: 1 }] }
const key = asideKey(main.paneId, record.id)
const aside: ChatState = { ...main, paneId: key, asides: undefined, session: { ...main.session, paneId: key, sessionId: 'aside', status: 'idle', aside: { ...record, parentPaneId: main.paneId } }, items: [{ id: 'aside-message', turnId: 't', kind: 'assistant_message', text: 'Aside answer', status: 'completed', createdAt: 1, updatedAt: 1 }] }
const handlers = () => ({ onSend: vi.fn(), onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn() })
function setup(state = main, initial?: string, thread: ChatState | null = aside) {
  const mainHandlers = handlers(), asideHandlers = handlers()
  const request = vi.fn<ChatAsideServices['request']>().mockResolvedValue({ ok: true, asideId: record.id })
  const flow = { queue: vi.fn(), task: vi.fn(), subagentTranscript: vi.fn(async () => ({ items: [] })), savePlan: vi.fn(async () => ({ path: '/plan.md' })) }
  const bindings = vi.fn((): ChatThreadBindings => ({ ...asideHandlers, flow }))
  function Harness() {
    const [selected, select] = useState(initial)
    return <ChatPane chat={state} connected focused={false} onFocus={() => {}} {...mainHandlers} asides={{ chats: thread ? { [key]: thread } : {}, selected, select, request, bindings }} />
  }
  const view = render(<Harness />)
  return { ...view, mainHandlers, asideHandlers, request, bindings, flow }
}
beforeEach(() => { localStorage.clear(); HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('aside threads', () => {
  it('quotes a Main message and sends its item id through Aside from here', async () => {
    const { request, mainHandlers } = setup()
    const action = screen.getByRole('button', { name: /Aside from here/ })
    action.focus()
    expect(action).toHaveFocus()
    fireEvent.click(action)
    expect(screen.getByRole('tab', { name: 'New aside' })).toHaveAttribute('aria-selected', 'true')
    expect(document.querySelector('blockquote')).toHaveTextContent('Main answer')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Explain this earlier point' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'open', text: 'Explain this earlier point', at: 'main-message', mode: 'read-only' }))
    expect(mainHandlers.onSend).not.toHaveBeenCalled()
  })
  it('places branch markers after the last row of the anchor turn and selects/reopens them', async () => {
    const older = { ...record, id: 'ijklmnop', title: 'Older', status: 'closed' as const, forkedFrom: { sessionId: 'main', itemId: 'first-user' } }
    const user = { ...main.items[0]!, id: 'first-user', kind: 'user_message' as const, text: 'First question' }
    const { request } = setup({ ...main, items: [user, ...main.items], asides: [{ ...record, forkedFrom: { sessionId: 'main', itemId: 'first-user' } }, older] })
    const marker = screen.getByRole('button', { name: '↳ Aside: Why flaky? · idle' })
    expect(screen.getByRole('button', { name: '↳ Aside: Older · closed' })).toBeInTheDocument()
    expect(marker.compareDocumentPosition(screen.getByText('Main answer')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Aside from here/ })).toHaveLength(2)
    fireEvent.click(marker)
    expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: /Main/ }))
    fireEvent.click(screen.getByRole('button', { name: '↳ Aside: Older · closed' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'reopen', asideId: older.id }))
  })
  it('routes /btw into an ephemeral answer without sending Main', async () => {
    const { request, mainHandlers } = setup({ ...main, asides: [] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/btw What is jitter?' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'open', text: 'What is jitter?', ephemeral: true }))
    expect(mainHandlers.onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: 'Quick aside' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Why flaky/ })).toBeNull()
  })
  it.each(['MacIntel', 'Linux'])('opens a quick question with the %s shortcut and dismisses with Esc', async (platform) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    const { request } = setup({ ...main, asides: [] })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: '/', metaKey: platform === 'MacIntel', ctrlKey: platform === 'Linux' })
    const question = screen.getByRole('textbox', { name: 'Quick question' })
    expect(question).toHaveFocus()
    fireEvent.keyDown(question, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Quick aside' })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
  it('streams a quick answer, copies it to Main draft, and keeps it as a selected aside', async () => {
    const quick = { ...record, ephemeral: true as const }
    const { request } = setup({ ...main, asides: [quick] })
    const popover = screen.getByRole('region', { name: 'Quick aside' })
    expect(within(popover).getByText('Aside answer')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(within(popover).getByRole('button', { name: 'Copy into Main draft' }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Aside answer'))
    fireEvent.click(within(popover).getByRole('button', { name: 'Keep as aside' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'keep', asideId: record.id }))
  })
  it('discards a quick answer with Esc while leaving the Main draft untouched', async () => {
    const { request } = setup({ ...main, asides: [{ ...record, ephemeral: true }] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Main draft' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'discard', asideId: record.id }))
    expect(screen.getByRole('textbox')).toHaveValue('Main draft')
  })
  it('offers /btw in the slash menu', () => {
    setup({ ...main, asides: [] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/bt', selectionStart: 3 } })
    fireEvent.click(screen.getByRole('option', { name: /Quick answer, no tools, nothing saved/ }))
    expect(screen.getByRole('textbox')).toHaveValue('/btw ')
  })
  it('hides discarded/ephemeral records and labels promoted chats without Reopen', () => {
    const onAction = vi.fn()
    render(<AsideTabs main={{ ...main, asides: [{ ...record, status: 'promoted' }, { ...record, id: 'ijklmnop', ephemeral: true }, { ...record, id: 'qrstuvwx', status: 'discarded' }] }} chats={{}} selected={undefined} onSelect={() => {}} onAction={onAction} disabled={false} />)
    expect(screen.queryByRole('tab', { name: /Why flaky/ })).toBeNull()
    fireEvent.click(screen.getByText('Closed (1)'))
    expect(screen.getByText('Opened as chat')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reopen/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Open as chat/ }))
    expect(onAction).toHaveBeenCalledWith({ action: 'promote', asideId: record.id })
  })
  it('opens an aside as a chat from its banner', async () => {
    const { request } = setup(main, record.id)
    fireEvent.click(screen.getByRole('button', { name: 'Open as chat' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'promote', asideId: record.id }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true'))
  })
  it('hides tabs on unsupported hosts and chats without asides', () => {
    const view = setup({ ...main, session: { ...main.session, hostVersion: 8 } })
    expect(screen.queryByRole('tablist', { name: 'Chat threads' })).toBeNull()
    view.unmount()
    setup({ ...main, asides: [] })
    expect(screen.queryByRole('tablist', { name: 'Chat threads' })).toBeNull()
  })
  it('switches timeline, composer, and actions to the aside and preserves drafts on Main', () => {
    const { mainHandlers, asideHandlers, bindings } = setup()
    const mainInput = screen.getByRole('textbox')
    fireEvent.change(mainInput, { target: { value: 'Unsent main draft' } })
    fireEvent.click(screen.getByRole('tab', { name: /Why flaky/ }))
    expect(bindings).toHaveBeenCalledWith(key)
    expect(screen.queryByText('Main answer')).toBeNull()
    expect(screen.getByText('Aside answer')).toBeInTheDocument()
    expect(screen.getByText(/forked from Main.*Read-only/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Follow up aside' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(asideHandlers.onSend).toHaveBeenCalledWith('Follow up aside')
    expect(mainHandlers.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox')).toHaveValue('Unsent main draft')
  })
  it('keeps a non-empty aside draft on Esc', () => {
    setup(main, record.id)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Draft' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('aria-selected', 'true')
  })
  it.each(['slash', 'mac', 'other', 'new'] as const)('opens a read-only aside using %s', async (way) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(way === 'mac' ? 'MacIntel' : 'Linux')
    const { request, mainHandlers } = setup({ ...main, asides: [] })
    if (way === 'new') {
      // Reach the pseudo-tab through a first open aside, as a chat with no asides hides the strip.
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '/aside first' } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: '＋ Aside' }))
      expect(screen.getByRole('tab', { name: 'New aside' })).toBeInTheDocument()
    }
    fireEvent.change(screen.getByRole('textbox'), { target: { value: way === 'slash' ? '/aside Why flaky?' : 'Why flaky?' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: way === 'mac' || way === 'other', metaKey: way === 'mac', ctrlKey: way === 'other' })
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'open', text: 'Why flaky?', mode: 'read-only' }))
    expect(mainHandlers.onSend).not.toHaveBeenCalled()
  })
  it('offers /aside in the slash menu and keeps it in the draft when selected', () => {
    setup({ ...main, asides: [] })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/asi', selectionStart: 4 } })
    fireEvent.click(screen.getByRole('option', { name: /aside/ }))
    expect(screen.getByRole('textbox')).toHaveValue('/aside ')
  })
  it('shows lifecycle failures inline and keeps the draft for retry', async () => {
    const { request } = setup()
    request.mockResolvedValue({ ok: false, error: 'At most 5 open asides' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/aside Why flaky?' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 5 open asides')
    expect(screen.getByRole('textbox')).toHaveValue('/aside Why flaky?')
  })
  it('changes mode, confirms refork, closes and reopens', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { request } = setup({ ...main, asides: [record, { ...record, id: 'ijklmnop', title: 'Old aside', status: 'closed' }] }, record.id)
    fireEvent.click(screen.getByRole('button', { name: 'Allow edits' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'mode', asideId: record.id, mode: 'inherit' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refork' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refork' }))
    expect(confirm).toHaveBeenCalledWith("Replaces this aside's conversation with a fresh fork of Main's latest finished turn")
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'refork' }))
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Refork' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'refork', asideId: record.id }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.click(screen.getByText('Closed (1)'))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Old aside' }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'reopen', asideId: 'ijklmnop' }))
  })
  it('derives status dots from each thread including open requests', () => {
    const waiting: ChatState = { ...aside, items: [{ id: 'r', kind: 'request', requestId: 'r', requestKind: 'approval', title: 'Allow?', toolName: 'Bash', turnId: 't', status: 'running', createdAt: 1, updatedAt: 1 }] }
    render(<AsideTabs main={main} chats={{ [key]: waiting }} selected={undefined} onSelect={() => {}} onAction={() => {}} disabled={false} />)
    expect(within(screen.getByRole('tab', { name: /Main/ })).getByRole('img', { name: 'running' })).toBeInTheDocument()
    expect(within(screen.getByRole('tab', { name: /Why flaky/ })).getByRole('img', { name: 'needs answer' })).toBeInTheDocument()
  })
  it('offers reopen and an error dot for a stopped aside without a chat', async () => {
    const { request } = setup({ ...main, asides: [{ ...record, lastError: 'Provider crashed' }] }, record.id, null)
    expect(within(screen.getByRole('tab', { name: /Why flaky/ })).getByRole('img', { name: 'error' })).toBeInTheDocument()
    expect(screen.getByText(/This aside stopped: Provider crashed/)).toBeInTheDocument()
    let finish!: () => void
    request.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: false, error: 'Resume failed' }) }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(request).toHaveBeenCalledWith({ action: 'reopen', asideId: record.id })
    expect(screen.queryByText(/This aside stopped/)).toBeNull()
    expect(screen.getByText('Loading aside…')).toBeInTheDocument()
    expect(within(screen.getByRole('tab', { name: /Why flaky/ })).queryByRole('img', { name: 'error' })).toBeNull()
    await act(async () => finish())
    expect(screen.getByText(/This aside stopped: Provider crashed/)).toBeInTheDocument()
  })
  it('shows saved-aside read errors even with an empty record list', () => {
    setup({ ...main, asides: [], asidesError: 'EACCES' })
    expect(screen.getByRole('alert')).toHaveTextContent("Saved asides couldn't be read: EACCES")
  })
  it('shows the last error in the Closed list', () => {
    setup({ ...main, asides: [{ ...record, status: 'closed', lastError: 'Resume failed' }] })
    fireEvent.click(screen.getByText('Closed (1)'))
    expect(screen.getByText('Resume failed')).toBeInTheDocument()
  })
  it('shows session-id save errors in the live aside banner', () => {
    setup({ ...main, asides: [{ ...record, lastError: 'Disk full' }] }, record.id)
    expect(screen.getByText('Disk full')).toBeInTheDocument()
    expect(screen.getByText('Aside answer')).toBeInTheDocument()
  })
  it('keeps the error dot for a stopped aside while a different aside is pending', () => {
    render(<AsideTabs main={main} chats={{}} selected={record.id} onSelect={() => {}} onAction={() => {}} disabled pending={(id) => id === 'ijklmnop'} />)
    expect(within(screen.getByRole('tab', { name: /Why flaky/ })).getByRole('img', { name: 'error' })).toBeInTheDocument()
  })
  it('prefers provider titles, falls back to record titles, and keeps close buttons outside tabs', () => {
    const onSelect = vi.fn(), onAction = vi.fn()
    const titled = { ...aside, session: { ...aside.session, title: 'Provider title' } }
    const view = render(<AsideTabs main={main} chats={{ [key]: titled }} selected={record.id} onSelect={onSelect} onAction={onAction} disabled={false} />)
    const tab = screen.getByRole('tab', { name: /Provider title/ })
    expect(tab).toHaveAttribute('title', 'Provider title')
    expect(within(tab).queryByRole('button')).toBeNull()
    const close = screen.getByRole('button', { name: 'Close aside Provider title' })
    expect(close).toHaveAttribute('type', 'button')
    expect(close.closest('[role=tab]')).toBeNull()
    close.focus()
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'ArrowRight' })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(close)
    expect(onAction).toHaveBeenCalledWith({ action: 'close', asideId: record.id })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(tab, { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenCalledWith(undefined)
    expect(screen.getByRole('tab', { name: /Main/ })).toHaveFocus()
    view.rerender(<AsideTabs main={main} chats={{}} selected={record.id} onSelect={onSelect} onAction={onAction} disabled />)
    expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('title', record.title)
    const disabledClose = screen.getByRole('button', { name: `Close aside ${record.title}` })
    expect(disabledClose).toBeDisabled()
    onAction.mockClear()
    fireEvent.click(disabledClose)
    expect(onAction).not.toHaveBeenCalled()
  })
  it('uses provider titles in the closed list', () => {
    render(<AsideTabs main={{ ...main, asides: [{ ...record, status: 'closed' }] }} chats={{ [key]: { ...aside, session: { ...aside.session, title: 'Finished investigation' } } }} selected={undefined} onSelect={() => {}} onAction={() => {}} disabled={false} />)
    fireEvent.click(screen.getByText('Closed (1)'))
    expect(screen.getByText('Finished investigation')).toHaveAttribute('title', 'Finished investigation')
    expect(screen.getByRole('button', { name: 'Reopen Finished investigation' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Close aside/ })).toBeNull()
  })
  it.each([undefined, record.id])('closes an aside from its tab when selection is %s', async (selected) => {
    const { request } = setup(main, selected)
    fireEvent.click(screen.getByRole('button', { name: `Close aside ${record.title}` }))
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'close', asideId: record.id }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true'))
  })
  it('handles success arriving before the record broadcast', async () => {
    const { request } = setup({ ...main, asides: [] })
    let finish!: (result: { ok: boolean; asideId: string }) => void
    request.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/aside question' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    await act(async () => finish({ ok: true, asideId: record.id }))
    expect(screen.getByText('Loading aside…')).toBeInTheDocument()
  })
  it.each([
    { mode: 'read-only' as const, readOnlyEnforced: true, label: 'Read-only', next: 'inherit' },
    { mode: 'read-only' as const, readOnlyEnforced: false, label: 'Read-only (advisory)', next: 'inherit' },
    { mode: 'inherit' as const, readOnlyEnforced: true, label: 'Full access', next: 'read-only' },
  ])('labels $label and toggles its mode', ({ mode, readOnlyEnforced, label, next }) => {
    const onAction = vi.fn()
    render(<AsideBanner aside={{ ...record, mode, readOnlyEnforced }} disabled={false} onAction={onAction} />)
    expect(screen.getByText(new RegExp(label.replace(/[()]/g, '\\$&')))).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: mode === 'read-only' ? 'Allow edits' : 'Make read-only' })
    expect(toggle).toHaveAttribute('title', mode === 'read-only' ? "Lets this aside use Main's permissions, including edits" : 'Blocks edit tools in this aside')
    fireEvent.click(toggle)
    expect(onAction).toHaveBeenCalledWith({ action: 'mode', asideId: record.id, mode: next })
  })

  it('uses the aside subagent services and lets Esc leave its subagent before returning to Main', async () => {
    const thread: ChatState = { ...aside, items: [{ id: 'task', turnId: 't', kind: 'subagent', toolUseId: 'task', agentId: 'agent-1', description: 'Check tests', state: 'completed', status: 'completed', createdAt: 1, updatedAt: 1 }] }
    const { flow } = setup(main, record.id, thread)
    fireEvent.click(screen.getByRole('button', { name: 'Open subagent Check tests' }))
    await waitFor(() => expect(flow.subagentTranscript).toHaveBeenCalledWith('agent-1'))
    expect(screen.getByTestId('subagent-header')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByTestId('subagent-header')).toBeNull()
    expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true')
  })
  it('attributes a stashed aside draft to its parent pane and its own session', async () => {
    const push = vi.fn(async () => ({ id: 'stash', text: '', images: [], createdAt: 1, source: { paneId: '%5' } }))
    const stash: ChatStash = { entries: [], push, take: vi.fn() }
    render(<ChatStashContext.Provider value={stash}><ChatComposer session={aside.session} hostConnected requests={[]} {...handlers()} /></ChatStashContext.Provider>)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Aside draft' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', ctrlKey: true })
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ text: 'Aside draft', source: expect.objectContaining({ paneId: '%5', sessionId: 'aside' }) })))
  })

})
