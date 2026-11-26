// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASIDE_REPORT_PROMPT, asideKey, asideReportText, type ChatAsideRecord, type ChatItem, type ChatState } from '../../shared/agent-chat'
import { ChatPane, type ChatAsideServices, type ChatThreadBindings } from './ChatPane'
import { saveDraft, loadDraft, loadReportSends, updateDraftReports } from './draftStore'

const record: ChatAsideRecord = { id: 'abcdefgh', title: 'Why flaky?', mode: 'read-only', method: 'fork', readOnlyEnforced: true, forkedFrom: { sessionId: 'main' }, createdAt: 1, status: 'open' }
const key = asideKey('%5', record.id)
const base = { turnId: 'old', status: 'completed' as const, createdAt: 1, updatedAt: 1 }
const main: ChatState = { paneId: '%5', hostConnected: true, asides: [record], session: { paneId: '%5', sessionId: 'main', provider: 'claude', cwd: '/work', status: 'running', hostPid: 1, hostVersion: 10 }, items: [] }
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
    refuseMain: (requestIds = ['main-send']) => act(() => changeMainError({ message: 'Main refused the report', refused: requestIds.map((requestId) => ({ requestId })) })),
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); updateDraftReports('main', { reportSends: [] }) })

describe('Report to Main', () => {
  it.each(['Ready code word IBIS', 'Own investigation'])('uses the aside’s own title in report headings and deliveries (session title: %s)', (title) => {
    const mainTitle = 'Ready code word IBIS'
    const expected = title === mainTitle ? record.title : title
    const view = setup({ ...main, session: { ...main.session, title: mainTitle } }, { ...aside, session: { ...aside.session, title } })
    manualReport()
    expect(screen.getByText(`From aside “${expected}”`)).toBeInTheDocument()
    sendReport()
    expect(view.onSend).toHaveBeenCalledWith(asideReportText({ asideId: record.id, title: expected, body }), undefined, { delivery: 'queue' })
  })
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
  it.each(['disconnected', 'missing'] as const)('keeps drafting through a %s chat and re-scans its completed reply on reconnect', (state) => {
    const view = setup(); clickReport()
    view.updateThread({ ...aside, session: { ...aside.session, status: 'running' }, items: [...aside.items, prompt] })
    view.updateThread(state === 'missing' ? undefined : { ...aside, hostConnected: false })
    expect(screen.getByText('Waiting for the aside to reconnect…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send to Main' })).toBeDisabled()
    expect(screen.queryByRole('textbox', { name: 'Report text' })).toBeNull()
    // Session status can reconnect before its timeline arrives.
    view.updateThread({ ...aside })
    expect(screen.getByText('Drafting…')).toBeInTheDocument()
    view.updateThread({ ...aside, items: [...aside.items, prompt, reply] })
    expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue(body)
  })
  it.each(['closed', 'error', 'new-session', 'record-closed', 'record-gone'] as const)('stops drafting when the aside is %s', (state) => {
    const view = setup(); clickReport()
    if (state === 'record-closed' || state === 'record-gone') view.updateMain({ ...main, asides: state === 'record-gone' ? [] : [{ ...record, status: 'closed' }] })
    else view.updateThread({ ...aside, session: { ...aside.session, ...(state === 'new-session' ? { sessionId: 'replacement' } : { status: state }) } })
    // Closing/removing a record switches to Main; reopening the tab is not required to end the draft.
    if (state !== 'record-closed' && state !== 'record-gone') {
      expect(screen.queryByText('Drafting…')).toBeNull()
      expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue('')
      expect(within(screen.getByRole('region', { name: 'Report to Main' })).getByRole('alert')).toBeInTheDocument()
    }
    view.updateThread({ ...aside, items: [...aside.items, prompt, reply] })
    if (state === 'record-closed' || state === 'record-gone') {
      view.updateMain(main); selectAside()
      expect(screen.getByRole('textbox', { name: 'Report text' })).toHaveValue('')
    }
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
    expect(view.request).not.toHaveBeenCalled()
    selectAside(); selectMain()
    expect(screen.getByLabelText('Aside references')).toHaveTextContent(`From aside ${record.title}`)
    const input = screen.getByRole('textbox', { name: 'Message Claude' })
    fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
    expect(view.onSend).toHaveBeenCalledExactlyOnceWith(`${envelope}\n\nUse this finding`, [], { delivery: 'queue' })
    expect(screen.queryByLabelText('Aside references')).toBeNull()
    expect(view.request).toHaveBeenCalledExactlyOnceWith({ action: 'close', asideId: record.id })
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
    expect(view.request).not.toHaveBeenCalled()
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
    expect(queue).toHaveTextContent('From aside “Why flaky?”: Found the race')
    expect(queue).not.toHaveTextContent('commando-aside:')
  })
})


it('restores references with Main’s text and images after the whole pane remounts', async () => {
  const image = { id: `${'a'.repeat(64)}.png`, name: 'photo.png' }
  saveDraft('main', 'Typed earlier', [image])
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  expect(view.request).not.toHaveBeenCalled()
  view.unmount()
  expect(loadDraft('main')).toMatchObject({ text: 'Typed earlier', images: [image], references: [{ asideId: record.id, body, close: true }] })
  const remounted = setup(); selectMain()
  expect(screen.getByLabelText('Aside references')).toHaveTextContent(record.title)
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  expect(input).toHaveValue('Typed earlier')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(remounted.onSend).toHaveBeenCalledExactlyOnceWith(`${envelope}\n\nTyped earlier`, [image], { delivery: 'queue' })
  expect(remounted.request).toHaveBeenCalledExactlyOnceWith({ action: 'close', asideId: record.id })
  expect(loadDraft('main').references).toBeUndefined()
})

it('does not close a restored reference whose auto-close was unchecked', async () => {
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  view.unmount()
  const remounted = setup(); selectMain()
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Use it' } }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(remounted.request).not.toHaveBeenCalled()
})

it('recovers a queued refusal after remount, persists it while Main is unmounted and preserves attachments', async () => {
  const image = { id: `${'a'.repeat(64)}.png`, name: 'photo.png' }
  saveDraft('main', 'Existing words', [image])
  const view = setup(); manualReport(); sendReport()
  await act(async () => {})
  view.unmount()
  const remounted = setup(); remounted.refuseMain()
  expect(loadDraft('main')).toMatchObject({ text: `Existing words\n\n${envelope}`, images: [image] })
  remounted.unmount()
  setup(); selectMain()
  expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(`Existing words\n\n${envelope}`)
})

it.each(['steered', 'relay'] as const)('renders each report and typed text separately, keeping the %s label', (label) => {
  const second = asideReportText({ asideId: 'ijklmnop', title: 'Second aside', body: 'Second finding' })
  const view = setup({ ...main, items: [{ ...base, id: 'reports', kind: 'user_message', text: `${envelope}\n\n${second}\n\nUse both findings`, ...(label === 'steered' ? { steered: true } : { relayTo: { agentId: 'a1', label: 'helper' } }) }] })
  selectMain()
  const bubbles = view.container.querySelectorAll('.chat-aside-report-bubble')
  expect(bubbles).toHaveLength(2)
  expect(bubbles[0]).toHaveTextContent('Found the race')
  expect(bubbles[0]).not.toHaveTextContent('Second finding')
  expect(bubbles[1]).toHaveTextContent('Second finding')
  for (const bubble of bubbles) expect(bubble).not.toHaveTextContent('Use both findings')
  expect(screen.getByText('Use both findings')).toHaveClass('bg-message')
  expect(screen.getByText(label === 'steered' ? 'Steered: sent while Claude worked' : 'To @helper, relayed through main Claude')).toBeInTheDocument()
  expect(view.container.textContent).not.toContain('commando-aside')
})

it('shows every queued report and the typed message in the queue preview', () => {
  const second = asideReportText({ asideId: 'ijklmnop', title: 'Second aside', body: 'Second finding' })
  setup({ ...main, session: { ...main.session, queue: [{ id: 'q', text: `${envelope}\n\n${second}\n\nUse both findings` }] } }); selectMain()
  const queue = screen.getByLabelText('Queued messages')
  expect(queue).toHaveTextContent('From aside “Why flaky?”: Found the race')
  expect(queue).toHaveTextContent('From aside “Second aside”: Second finding')
  expect(queue).toHaveTextContent('Use both findings')
  expect(queue).not.toHaveTextContent('commando-aside')
})


it('recovers a refused reference and its typed message after the whole pane remounts', async () => {
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
  view.unmount()
  const remounted = setup(); remounted.refuseMain()
  selectMain()
  expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(`${envelope}\n\nUse this finding`)
  expect(loadDraft('main').text).toBe(`${envelope}\n\nUse this finding`)
})

it('does not duplicate a refused reference while Main is mounted', async () => {
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'New unsaved words' } })
  view.refuseMain()
  expect(input).toHaveValue(`New unsaved words\n\n${envelope}\n\nUse this finding`)
  expect(loadDraft('main').text).toBe(`New unsaved words\n\n${envelope}\n\nUse this finding`)
})

it.each([
  { failure: 'writes fail', remount: false },
  { failure: 'storage unavailable', remount: false },
  { failure: 'writes fail', remount: true },
  { failure: 'storage unavailable', remount: true },
])('recovers a refused reference and typed text when $failure (remount=$remount)', async ({ failure, remount }) => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
  if (failure === 'storage unavailable') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(view.onSend).toHaveBeenCalledExactlyOnceWith(`${envelope}\n\nUse this finding`, [], { delivery: 'queue' })
  expect(input).toHaveValue('')
  if (remount) {
    view.unmount()
    const remounted = setup(); remounted.refuseMain(); selectMain()
  } else view.refuseMain()
  expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(`${envelope}\n\nUse this finding`)
})

it.each(['queue', 'timeline'] as const)('clears report recovery after a %s acknowledgement even if storage removal fails', async (acknowledgement) => {
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  const text = `${envelope}\n\nUse this finding`
  fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(loadReportSends('main')).toHaveLength(1)
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('Blocked') })
  view.updateMain(acknowledgement === 'queue'
    ? { ...main, session: { ...main.session, queue: [{ id: 'accepted', text }] } }
    : { ...main, items: [{ ...base, id: 'accepted', kind: 'user_message', text }] })
  expect(loadReportSends('main')).toEqual([])
  expect(loadDraft('main').reportSends).toHaveLength(1)
  view.unmount()
  const remounted = setup(); remounted.refuseMain(); selectMain()
  expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue('')
})

it('does not treat an existing identical message as acknowledgement of a new report send', async () => {
  const text = `${envelope}\n\nUse this finding`
  const existing: ChatState = { ...main, items: [{ ...base, id: 'existing', kind: 'user_message', text }] }
  const view = setup(existing); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Use this finding' } }); fireEvent.keyDown(input, { key: 'Enter' })
  view.updateMain({ ...existing, items: [...existing.items] })
  expect(loadReportSends('main')).toHaveLength(1)
  view.refuseMain()
  expect(input).toHaveValue(text)
})

it('keeps manual draft delivery usable when storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
  setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Put in Main's composer/ })); sendReport()
  await act(async () => {})
  expect(screen.getByRole('textbox', { name: 'Message Claude' })).toHaveValue(envelope)
})

it('keeps pending references isolated when Main changes session', async () => {
  const view = setup(); manualReport()
  fireEvent.click(screen.getByRole('radio', { name: /Attach as reference/ })); sendReport()
  await act(async () => {})
  view.updateMain({ ...main, session: { ...main.session, sessionId: 'other-main' } })
  expect(screen.queryByLabelText('Aside references')).toBeNull()
  expect(loadDraft('main').references).toHaveLength(1)
  view.updateMain(main)
  expect(screen.getByLabelText('Aside references')).toHaveTextContent(record.title)
})


it('recovers multiple refused reports together without overwriting the unsaved Main draft', () => {
  const view = setup()
  view.onSend.mockReturnValueOnce('send-first').mockReturnValueOnce('send-second')
  for (const finding of ['First finding', 'Second finding']) {
    manualReport()
    fireEvent.change(screen.getByRole('textbox', { name: 'Report text' }), { target: { value: finding } })
    fireEvent.click(screen.getByRole('checkbox')); sendReport()
  }
  selectMain()
  const input = screen.getByRole('textbox', { name: 'Message Claude' })
  fireEvent.change(input, { target: { value: 'Unsaved original' } })
  view.refuseMain(['send-first', 'send-second'])
  const reports = ['First finding', 'Second finding'].map((body) => asideReportText({ asideId: record.id, title: record.title, body })).join('\n\n')
  expect(input).toHaveValue(`Unsaved original\n\n${reports}`)
  expect(loadDraft('main').text).toBe(`Unsaved original\n\n${reports}`)
})
