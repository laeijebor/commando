// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asideKey, asideReportText, type ChatAsideRecord, type ChatItem, type ChatState } from '../../shared/agent-chat'
import { ChatPane, type ChatAsideServices, type ChatThreadBindings } from './ChatPane'
import { ASIDE_REPORT_PROMPT } from './AsideReport'
import { saveDraft, loadDraft } from './draftStore'

const record: ChatAsideRecord = { id: 'abcdefgh', title: 'Why flaky?', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main' }, createdAt: 1, status: 'open' }
const key = asideKey('%5', record.id)
const base = { turnId: 'old', status: 'completed' as const, createdAt: 1, updatedAt: 1 }
const main: ChatState = { paneId: '%5', hostConnected: true, asides: [record], session: { paneId: '%5', sessionId: 'main', provider: 'claude', cwd: '/work', status: 'running', hostPid: 1, hostVersion: 9 }, items: [] }
const aside: ChatState = { ...main, paneId: key, asides: undefined, session: { ...main.session, paneId: key, sessionId: 'aside', status: 'idle', aside: { ...record, parentPaneId: '%5' } }, items: [{ ...base, id: 'old', kind: 'assistant_message', text: 'Old answer must not become the report' }] }
const body = 'Found the race\n- Fix **polling** in `src/file.ts`'
const envelope = asideReportText({ asideId: record.id, title: record.title, body })
const prompt: ChatItem = { ...base, turnId: 'draft-turn', id: 'draft-prompt', kind: 'user_message', text: ASIDE_REPORT_PROMPT }
const reply: ChatItem = { ...base, turnId: 'draft-turn', id: 'draft-reply', kind: 'assistant_message', text: body }
function setup(initialMain = main, initialThread: ChatState | undefined = aside, otherThreads: Record<string, ChatState> = {}) {
  const onSend = vi.fn(() => 'main-send')
  const asideSend = vi.fn(() => 'draft-send')
  const request = vi.fn<ChatAsideServices['request']>().mockResolvedValue({ ok: true, asideId: record.id })
  const queue = vi.fn()
  let changeMain: (chat: ChatState) => void, changeThread: (chat: ChatState | undefined) => void
  let sendError: ChatThreadBindings['sendError']
  let changeMainError: (error: ChatThreadBindings['sendError']) => void
  const bindings = vi.fn((): ChatThreadBindings => ({ onSend: asideSend, onInterrupt: vi.fn(), onAnswer: vi.fn(), onConfigure: vi.fn(), sendError }))
  function Harness() {
    const [chat, setChat] = useState(initialMain)
    const [thread, setThread] = useState<ChatState | undefined>(initialThread)
    const [selected, select] = useState<string | undefined>(record.id)
    const [mainError, setMainError] = useState<ChatThreadBindings['sendError']>()
    changeMainError = setMainError
    changeMain = setChat; changeThread = setThread
    return <ChatPane chat={chat} connected focused={false} onFocus={vi.fn()} onSend={onSend} onInterrupt={vi.fn()} onAnswer={vi.fn()} onConfigure={vi.fn()} sendError={mainError}
      flow={{ queue, task: vi.fn(), subagentTranscript: vi.fn(async () => ({ items: [] })), savePlan: vi.fn(async () => ({ path: '/plan' })) }}
      asides={{ chats: { ...otherThreads, ...(thread ? { [key]: thread } : {}) }, selected, select, request, bindings }} />
  }
  const view = render(<Harness />)
  return { ...view, onSend, asideSend, request, bindings,
    updateMain: (chat: ChatState) => act(() => changeMain(chat)),
    updateThread: (chat: ChatState | undefined) => act(() => changeThread(chat)),
    refuse: () => { sendError = { message: 'Message refused', refused: [{ requestId: 'draft-send' }] }; act(() => changeThread({ ...aside })) },
    refuseMain: () => act(() => changeMainError({ message: 'Main refused the report', refused: [{ requestId: 'main-send' }] })),
  }
}
const clickReport = () => fireEvent.click(screen.getByRole('button', { name: 'Report to Main' }))
function manualReport() {
  clickReport()
  fireEvent.click(screen.getByRole('button', { name: 'Write it myself' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Report text' }), { target: { value: body } })
}
const selectMain = () => fireEvent.click(screen.getByRole('tab', { name: /Main/ }))
const selectAside = () => fireEvent.click(screen.getByRole('tab', { name: /Why flaky/ }))
const sendReport = () => fireEvent.click(screen.getByRole('button', { name: 'Send to Main' }))
beforeEach(() => { localStorage.clear(); HTMLElement.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Report to Main', () => {
  it('sends the drafting prompt to the aside and fills only after its completed turn, even on another tab', () => {
    const view = setup()
    clickReport()
    expect(view.bindings).toHaveBeenCalledWith(key)
    expect(view.asideSend).toHaveBeenCalledExactlyOnceWith(ASIDE_REPORT_PROMPT)
    expect(view.onSend).not.toHaveBeenCalled()
    expect(screen.getByText('Drafting…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to Main' })).toBeDisabled()
    // A prompt broadcast can beat the running status; it must not count as a failed turn.
    view.updateThread({ ...aside, items: [...aside.items, prompt] })
    expect(screen.getByText('Drafting…')).toBeInTheDocument()
    view.updateThread({ ...aside, session: { ...aside.session, status: 'running' }, items: [...aside.items, prompt, { ...reply, status: 'running', text: 'Partial' }] })
    selectMain()
    view.updateThread({ ...aside, items: [...aside.items, prompt, reply] })
    selectAside()
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue(body)
    expect(screen.getByRole('radio', { name: 'Queue for Main after its current turn' })).toBeChecked()
  })
  it('ignores new assistants from a different turn or subagent', () => {
    const view = setup()
    clickReport()
    view.updateThread({ ...aside, session: { ...aside.session, status: 'running' }, items: [...aside.items, { ...reply, turnId: 'other' }, prompt, { ...reply, id: 'subagent', parentToolUseId: 'tool' }] })
    expect(screen.getByText('Drafting…')).toBeInTheDocument()
    view.updateThread({ ...aside, items: [...aside.items, prompt, reply] })
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue(body)
  })
  it.each(['failed', 'interrupted'] as const)('offers manual editing after a %s drafting turn', (status) => {
    const view = setup()
    clickReport()
    view.updateThread({ ...aside, session: { ...aside.session, status: 'running' }, items: [...aside.items, prompt] })
    view.updateThread({ ...aside, items: [...aside.items, prompt, { ...reply, status }] })
    expect(within(screen.getByRole('region', { name: 'Report to Main' })).getByRole('alert')).toHaveTextContent(/failed|interrupted/)
    fireEvent.click(screen.getByRole('button', { name: 'Write it myself' }))
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue('')
  })
  it('surfaces a refused drafting send', () => {
    const view = setup(); clickReport(); view.refuse()
    expect(within(screen.getByRole('region', { name: 'Report to Main' })).getByRole('alert')).toHaveTextContent('Message refused')
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue('')
  })
  it('keeps manual edits and delivery settings through tab switches and late draft completion', () => {
    const view = setup(); manualReport()
    fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Close aside after sending' }))
    selectMain(); view.updateThread({ ...aside, items: [...aside.items, prompt, reply] }); selectAside()
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue(body)
    expect(screen.getByRole('radio', { name: /Attach as reference/ })).toBeChecked()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })
  it('keeps a separate sheet and delivery choice for each aside', () => {
    const second = { ...record, id: 'ijklmnop', title: 'Second aside' }
    const secondKey = asideKey(main.paneId, second.id)
    setup({ ...main, asides: [record, second] }, aside, { [secondKey]: { ...aside, paneId: secondKey, session: { ...aside.session, paneId: secondKey, sessionId: 'second', aside: { ...second, parentPaneId: main.paneId } } } })
    manualReport()
    fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ }))
    fireEvent.click(screen.getByRole('tab', { name: /Second aside/ }))
    clickReport()
    fireEvent.click(screen.getByRole('button', { name: 'Write it myself' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Report text' }), { target: { value: 'Second finding' } })
    selectAside()
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue(body)
    expect(screen.getByRole('radio', { name: /Attach as reference/ })).toBeChecked()
    fireEvent.click(screen.getByRole('tab', { name: /Second aside/ }))
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue('Second finding')
    expect(screen.getByRole('radio', { name: /Queue for Main/ })).toBeChecked()
  })
  it.each(['idle', 'running'] as const)('queues the edited report explicitly to %s Main and auto-closes the source', async (status) => {
    const view = setup({ ...main, session: { ...main.session, status } }); manualReport()
    fireEvent.change(screen.getByRole('textbox', { name: 'Report text' }), { target: { value: 'Edited finding' } })
    sendReport()
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith(asideReportText({ asideId: record.id, title: record.title, body: 'Edited finding' }), undefined, { delivery: 'queue' })
    expect(view.request).toHaveBeenCalledExactlyOnceWith({ action: 'close', asideId: record.id })
    await act(async () => {})
    expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true')
  })
  it('keeps the aside open when auto-close is unchecked', () => {
    const view = setup(); manualReport()
    fireEvent.click(screen.getByRole('checkbox')); sendReport()
    expect(view.request).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('aria-selected', 'true')
  })
  it('recovers a refused queued report into Main’s draft even after the aside closed', async () => {
    const view = setup(); manualReport(); sendReport()
    await act(async () => {})
    view.refuseMain()
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(envelope)
    expect(screen.getByText('Main refused the report')).toBeInTheDocument()
  })
  it('leaves manual reporting available when the aside host disconnects', () => {
    const view = setup(); clickReport()
    view.updateThread({ ...aside, hostConnected: false })
    expect(within(screen.getByRole('region', { name: 'Report to Main' })).getByRole('alert')).toHaveTextContent(/disconnected/)
    fireEvent.change(screen.getByRole('textbox', { name: 'Report text' }), { target: { value: body } })
    expect(screen.getByRole('button', { name: 'Send to Main' })).toBeEnabled()
  })
  it('appends to an unmounted Main draft, preserving its images, and focuses Main', async () => {
    saveDraft('main', 'Existing draft', [{ id: `${'a'.repeat(64)}.png`, name: 'photo.png' }])
    const view = setup(); manualReport()
    fireEvent.click(screen.getByRole('radio', { name: /Put in Main's composer/ })); sendReport()
    await act(async () => {})
    const input = screen.getByRole('textbox', { name: 'Message Claude' })
    expect(input).toHaveValue(`Existing draft\n\n${envelope}`)
    expect(input).toHaveFocus()
    expect(view.onSend).not.toHaveBeenCalled()
    selectAside(); selectMain()
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(`Existing draft\n\n${envelope}`)
    expect(loadDraft('main').images).toHaveLength(1)
  })
  it('prepends a reference on the next Main send, survives tab switches, and then clears it', async () => {
    const view = setup(); manualReport()
    fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
    await act(async () => {})
    expect(view.onSend).not.toHaveBeenCalled()
    selectAside(); selectMain()
    expect(screen.getByLabelText('Aside references')).toHaveTextContent(`From aside ${record.title}`)
    const input = screen.getByRole('textbox', { name: 'Message Claude' })
    fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith(`${envelope}\n\nUse this finding`, [], { delivery: 'queue' })
    expect(screen.queryByLabelText('Aside references')).toBeNull()
    fireEvent.change(input, { target: { value: 'Follow-up' } }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(view.onSend).toHaveBeenLastCalledWith('Follow-up', [], { delivery: 'queue' })
  })
  it('removes a reference without including it in the next send', async () => {
    const view = setup(); manualReport()
    fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference Why flaky?' }))
    const input = screen.getByRole('textbox', { name: 'Message Claude' })
    fireEvent.change(input, { target: { value: 'No reference' } }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith('No reference', [], { delivery: 'queue' })
  })
  it('cancels without delivering or closing, and ignores a late assistant response', () => {
    const view = setup(); clickReport()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    view.updateThread({ ...aside, items: [...aside.items, prompt, reply] })
    expect(screen.queryByRole('region', { name: 'Report to Main' })).toBeNull()
    expect(view.onSend).not.toHaveBeenCalled(); expect(view.request).not.toHaveBeenCalled()
  })
  it.each(['open', 'closed', 'gone'] as const)('renders report markdown and offers to open a source that is %s', async (state) => {
    const view = setup({ ...main, asides: state === 'gone' ? [] : [{ ...record, status: state }], items: [{ ...base, id: 'report', kind: 'user_message', text: envelope }] })
    selectMain()
    const bubble = screen.getByText('From aside').closest('.chat-aside-report-bubble')!
    expect(bubble.querySelector('strong')).toHaveTextContent(record.title)
    expect(bubble.querySelector('code')).toHaveTextContent('src/file.ts')
    expect(bubble.textContent).not.toContain('commando-aside:')
    fireEvent.click(screen.getByRole('button', { name: 'Open aside ↗' }))
    if (state === 'open') expect(screen.getByRole('tab', { name: /Why flaky/ })).toHaveAttribute('aria-selected', 'true')
    else {
      fireEvent.click(within(screen.getByRole('region', { name: 'Report source' })).getByRole('button', { name: 'Reopen' }))
      expect(view.request).toHaveBeenCalledWith({ action: 'reopen', asideId: record.id })
      await act(async () => {})
    }
  })
  it('labels a queued report with its title instead of its envelope', () => {
    setup({ ...main, session: { ...main.session, queue: [{ id: 'q1', text: envelope }] } })
    selectMain()
    const queue = screen.getByLabelText('Queued messages')
    expect(queue).toHaveTextContent('From aside Why flaky?')
    expect(queue).not.toHaveTextContent('commando-aside:')
  })
})
