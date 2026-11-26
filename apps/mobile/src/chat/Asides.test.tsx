import { ActionSheetIOS, Alert, StyleSheet } from 'react-native'
import { act, fireEvent, render, screen, within } from '@testing-library/react-native'
import { ASIDE_REPORT_PROMPT, CHAT_ASIDES_HOST_VERSION, asideKey, asideReportText, type ChatAsideRecord, type ChatState } from '@commando/agent-chat'
import type { ServerMessage } from '@commando/protocol'
import { THEMES, ThemeProvider } from '../theme'
import type { ConnectionPhase } from '../daemon/state'
import type { Host } from '../hosts/types'
import { createChatRowSelector } from '../ui/chatRowMetadata'
import { parseNotificationData, notificationRoute } from '../notifications/routing'
import { PaneView } from '../terminal/PaneView'
import { AsideThreads, threadStatus } from './AsideThreads'
import { ChatView } from './ChatView'
import { applyChatMessage, useChat, useChatStore } from './store'
import { chatState, fakeClient, item, session } from './testing'

jest.mock('../terminal/TerminalSurface', () => ({ TerminalSurface: () => null }))

const HOST: Host = { id: 'asides-test', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const OPEN: ChatAsideRecord = { id: 'aside001', title: 'Investigate layout', status: 'open', mode: 'read-only', method: 'fork', readOnlyEnforced: true, createdAt: 1000, forkedFrom: { sessionId: 'main-session' } }
const CLOSED: ChatAsideRecord = { ...OPEN, id: 'aside002', title: 'Previous check', status: 'closed' }
const KEY = asideKey('%7', OPEN.id)
const mainChat = () => chatState({ asides: [OPEN, CLOSED], session: session({ hostVersion: CHAT_ASIDES_HOST_VERSION, sessionId: 'main-session' }), items: [item('user_message', { text: 'Main question' })] })
const asideChat = () => chatState({ paneId: KEY, session: session({ aside: { ...OPEN, parentPaneId: '%7' }, paneId: KEY, hostVersion: CHAT_ASIDES_HOST_VERSION, title: OPEN.title, sessionId: 'aside-session' }), items: [item('assistant_message', { text: 'Aside answer' })] })

function setup(main = mainChat(), aside: ChatState | null = asideChat(), host = HOST) {
  const client = fakeClient()
  const emit = (message: ServerMessage) => act(() => client.emit(message))
  client.subscribe((message) => useChatStore.getState().ingest(host.id, message))
  useChatStore.getState().ingest(host.id, { type: 'chat_snapshot', chats: [main, ...(aside ? [aside] : [])] })
  function Harness({ phase = 'live' }: { phase?: ConnectionPhase }) {
    const chat = useChat(host.id, '%7')!
    return <ThemeProvider><ChatView host={host} chat={chat} client={client} phase={phase} /></ThemeProvider>
  }
  const view = render(<Harness />)
  return { client, emit, setPhase: (phase: ConnectionPhase) => view.rerender(<Harness phase={phase} />) }
}
async function settle() { await act(async () => undefined) }
function selectAside() { fireEvent.press(screen.getByLabelText('Investigate layout, idle')) }
async function report() {
  selectAside()
  fireEvent.press(screen.getByLabelText('Aside actions'))
  fireEvent.press(screen.getByLabelText('Report to Main'))
  await settle()
}
function finishReport(emit: (message: ServerMessage) => void, body = 'A concrete finding') {
  emit({ type: 'chat_items', paneId: KEY, items: [
    item('user_message', { text: ASIDE_REPORT_PROMPT, turnId: 'report-turn' }),
    item('assistant_message', { text: 'Unrelated subagent answer', turnId: 'report-turn', parentToolUseId: 'tool' }),
    item('assistant_message', { text: body, turnId: 'report-turn' }),
  ] })
}
beforeEach(() => { jest.useFakeTimers({ now: 180_000 }); useChatStore.setState({ byHost: {}, externalRuns: {}, tileEvents: {} }) })
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks() })

it.each(['aside', 'Main'] as const)('restores a refused %s send with attachments after switching away', async (source) => {
  const image = { id: `${'a'.repeat(64)}.png`, name: `${source}-refused.png` }
  const carried = { id: `switch-refusal-${source}`, text: '', images: [image] }
  const main = mainChat(), aside = asideChat()
  if (source === 'Main') main.carried = carried
  else aside.carried = carried
  const { client, emit } = setup(main, aside, { ...HOST, id: `switch-refusal-${source}` })
  if (source === 'aside') selectAside()
  await settle()
  const field = screen.getByTestId('chat-input')
  fireEvent.changeText(field, `Pending ${source} message`)
  expect(screen.getByLabelText(`Remove ${image.name}`)).toBeTruthy()
  fireEvent.press(screen.getByLabelText('Send'))
  const sent = client.last('chat_send')!
  expect(sent).toMatchObject({ paneId: source === 'aside' ? KEY : '%7', images: [image] })
  expect(field.props.value).toBe('')

  if (source === 'aside') fireEvent.press(screen.getByLabelText('Main, idle'))
  else selectAside()
  const otherField = screen.getByTestId('chat-input')
  fireEvent.changeText(otherField, 'Other thread draft')
  expect(field.props.editable).toBe(false)
  expect(field.props.autoFocus).toBe(false)
  const subscriptions = jest.spyOn(client, 'subscribe')
  emit({ type: 'error', code: 'chat_unavailable', message: 'Send refused while hidden', requestId: sent.requestId })
  expect(screen.queryByText('Send refused while hidden')).toBeNull()
  expect(otherField.props.value).toBe('Other thread draft')
  // The original composer already recovered while hidden, before revisiting it.
  expect(field.props.value).toBe(`Pending ${source} message`)
  expect(screen.getAllByTestId('chat-input', { includeHiddenElements: true })).toHaveLength(2)

  if (source === 'aside') selectAside()
  else fireEvent.press(screen.getByLabelText('Main, idle'))
  expect(screen.getByTestId('chat-input')).toBe(field)
  expect(field.props.editable).toBe(true)
  expect(otherField.props.editable).toBe(false)
  expect(screen.getByText('Send refused while hidden')).toBeTruthy()
  expect(screen.getByLabelText(`Remove ${image.name}`)).toBeTruthy()
  // Revisiting again must neither remount nor restore the same refusal twice.
  if (source === 'aside') { fireEvent.press(screen.getByLabelText('Main, idle')); selectAside() }
  else { selectAside(); fireEvent.press(screen.getByLabelText('Main, idle')) }
  expect(screen.getByTestId('chat-input')).toBe(field)
  expect(field.props.value).toBe(`Pending ${source} message`)
  expect(screen.getAllByLabelText(`Remove ${image.name}`)).toHaveLength(1)
  expect(subscriptions).not.toHaveBeenCalled()
})

it.each(['closed', 'discarded'] as const)('unmounts a visited aside when it is %s, keeping Main mounted', (status) => {
  const { emit } = setup()
  const mainField = screen.getByTestId('chat-input')
  selectAside()
  fireEvent.press(screen.getByLabelText('Main, idle'))
  expect(screen.getAllByTestId('chat-input', { includeHiddenElements: true })).toHaveLength(2)
  emit({ type: 'chat_asides', paneId: '%7', asides: [{ ...OPEN, status }] })
  expect(screen.getAllByTestId('chat-input', { includeHiddenElements: true })).toHaveLength(1)
  expect(screen.getByTestId('chat-input')).toBe(mainField)
})

it('keeps a queued edit across switches without leaving its hidden editor focusable', () => {
  const main = mainChat()
  main.session = { ...main.session, status: 'running', queue: [{ id: 'queued', text: 'Queued follow-up' }] }
  setup(main)
  fireEvent.press(screen.getByLabelText('Edit queued message'))
  const editor = screen.getByLabelText('Edit queued message')
  fireEvent.changeText(editor, 'Half-edited follow-up')
  selectAside()
  expect(editor.props.autoFocus).toBe(false)
  expect(editor.props.editable).toBe(false)
  expect(screen.queryByLabelText('Edit queued message')).toBeNull()
  fireEvent.press(screen.getByLabelText('Main, running'))
  expect(screen.getByLabelText('Edit queued message')).toBe(editor)
  expect(editor.props.editable).toBe(true)
  expect(editor.props.value).toBe('Half-edited follow-up')
})

it('folds asides and read errors into Main, clearing an old error on success', () => {
  const first = applyChatMessage({ '%7': mainChat() }, { type: 'chat_asides', paneId: '%7', asides: [CLOSED], error: 'Unreadable file' })
  expect(first['%7']).toMatchObject({ asides: [CLOSED], asidesError: 'Unreadable file' })
  expect(applyChatMessage(first, { type: 'chat_asides', paneId: '%7', asides: [OPEN] })['%7']?.asidesError).toBeUndefined()
  expect(applyChatMessage(first, { type: 'chat_asides', paneId: '%8', asides: [] })).toBe(first)
})
it('keeps aside streams available but excludes their changes from stable row metadata and pane views', () => {
  const main = mainChat(), aside = asideChat()
  const selector = createChatRowSelector('h')
  const first = selector({ byHost: { h: { '%7': main, [KEY]: aside } } })
  expect(Object.keys(first)).toEqual(['%7'])
  expect(selector({ byHost: { h: { '%7': main, [KEY]: { ...aside, items: [item('request', { requestId: 'q', requestKind: 'approval', toolName: 'Edit', title: 'Edit?', status: 'running' })] } } } })).toBe(first)
  render(<PaneView host={HOST} paneId={KEY} active onOpenTile={jest.fn()} onSelectWindow={jest.fn()} />)
  expect(screen.getByText('Open asides from their Main chat.')).toBeTruthy()
  expect(parseNotificationData({ paneId: KEY, kind: 'done' })).toBeNull()
  expect(notificationRoute({ paneId: KEY, kind: 'done' }, HOST.id)).toBeNull()
})
it('draws status chips and a closed sheet; all aside sends target the aside key', async () => {
  const { client, emit } = setup()
  expect(screen.getByLabelText('Main, idle')).toBeTruthy()
  selectAside()
  expect(screen.queryByText('Main question')).toBeNull()
  expect(screen.getByText('Aside answer')).toBeTruthy()
  expect(screen.getByText(/Aside · forked from Main 2m ago · Read-only/)).toBeTruthy()
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Follow up')
  fireEvent.press(screen.getByLabelText('Send'))
  expect(client.last('chat_send')).toMatchObject({ paneId: KEY, text: 'Follow up' })
  fireEvent.press(screen.getByLabelText('Closed (1)'))
  fireEvent.press(screen.getByLabelText('Reopen Previous check'))
  expect(client.last('chat_aside')).toMatchObject({ paneId: '%7', action: { action: 'reopen', asideId: CLOSED.id } })
  emit({ type: 'chat_aside_result', paneId: '%7', requestId: client.last('chat_aside')!.requestId, ok: true, asideId: CLOSED.id })
  await settle()
})
it('hides ephemeral and discarded asides and lists promoted asides without Reopen', () => {
  const hidden: ChatAsideRecord[] = [
    { ...OPEN, id: 'temp0001', title: 'Temporary open', ephemeral: true },
    { ...CLOSED, id: 'temp0002', title: 'Temporary closed', ephemeral: true },
    { ...CLOSED, id: 'temp0003', title: 'Temporary promoted', status: 'promoted', ephemeral: true },
    { ...OPEN, id: 'drop0001', title: 'Discarded check', status: 'discarded' },
  ]
  setup({ ...mainChat(), asides: [...mainChat().asides!, ...hidden, { ...CLOSED, id: 'chat0001', title: 'Promoted check', status: 'promoted' }] })
  for (const record of hidden) expect(screen.queryByLabelText(`${record.title}, stopped-error`)).toBeNull()
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  fireEvent.press(screen.getByLabelText('Closed (2)'))
  for (const record of hidden) expect(screen.queryByText(record.title)).toBeNull()
  expect(screen.getByText('Promoted check')).toBeTruthy()
  expect(screen.getByText('Opened as chat')).toBeTruthy()
  expect(screen.queryByLabelText('Reopen Promoted check')).toBeNull()
  expect(screen.getByLabelText('Reopen Previous check')).toBeTruthy()
})
it('does not show the thread strip for only ephemeral or discarded records', () => {
  setup({ ...mainChat(), asides: [{ ...OPEN, ephemeral: true }, { ...CLOSED, status: 'discarded' }] })
  expect(screen.queryByLabelText('Chat threads')).toBeNull()
  expect(screen.queryByText(/^Closed \(/)).toBeNull()
})
it.each(['discarded', 'promoted', 'ephemeral'] as const)('returns to Main when the selected aside becomes %s', (state) => {
  const { emit } = setup()
  selectAside()
  emit({ type: 'chat_asides', paneId: '%7', asides: [{ ...OPEN, ...(state === 'ephemeral' ? { ephemeral: true as const } : { status: state }) }] })
  expect(screen.getByText('Main question')).toBeTruthy()
  expect(screen.queryByText('Aside answer')).toBeNull()
  expect(screen.queryByText('Loading aside…')).toBeNull()
})
it('shows stopped records with lastError and Reopen, and surfaces saved-aside errors', () => {
  setup({ ...mainChat(), asides: [{ ...OPEN, lastError: 'Host exited' }], asidesError: 'Permission denied' }, null)
  fireEvent.press(screen.getByLabelText('Investigate layout, stopped-error'))
  expect(screen.getByText('This aside stopped: Host exited')).toBeTruthy()
  expect(screen.getByLabelText('Reopen')).toBeTruthy()
  expect(screen.getByText(/Saved asides couldn't be read: Permission denied/)).toBeTruthy()
})
it('exposes each thread status including pending answers and stopped sessions', () => {
  expect(threadStatus()).toBe('stopped-error')
  expect(threadStatus(chatState({ session: session({ status: 'running' }) }))).toBe('running')
  expect(threadStatus(chatState({ session: session({ status: 'waiting' }) }))).toBe('needs answer')
  expect(threadStatus(chatState({ session: session({ status: 'closed' }) }))).toBe('stopped-error')
})
it.each(['new', 'toggle', 'prefix'])('starts an aside using %s without sending the question to Main', async (method) => {
  const { client, emit } = setup()
  if (method === 'new') { fireEvent.press(screen.getByLabelText('+ Aside')); expect(screen.queryByText('Main question')).toBeNull() }
  if (method === 'toggle') fireEvent.press(screen.getByLabelText('Send as aside: Send as aside'))
  fireEvent.changeText(screen.getByTestId('chat-input'), method === 'prefix' ? '/aside Check layout' : 'Check layout')
  fireEvent.press(screen.getByLabelText(method === 'prefix' ? 'Send' : 'Send aside'))
  expect(client.last('chat_send')).toBeUndefined()
  const request = client.last('chat_aside')!
  expect(request).toMatchObject({ paneId: '%7', action: { action: 'open', text: 'Check layout', mode: 'read-only' } })
  emit({ type: 'chat_aside_result', paneId: '%7', requestId: request.requestId, ok: false, error: 'Fork failed' })
  await settle()
  expect(screen.getByTestId('chat-input').props.value).toContain('Check layout')
  expect(screen.getByText('Fork failed')).toBeTruthy()
})
it('requires Alert confirmation for refork, and changes permissions through Main', async () => {
  const alert = jest.spyOn(Alert, 'alert')
  const { client, emit } = setup()
  selectAside()
  fireEvent.press(screen.getByLabelText('Aside actions'))
  fireEvent.press(screen.getByLabelText('Allow edits'))
  expect(client.last('chat_aside')).toMatchObject({ paneId: '%7', action: { action: 'mode', asideId: OPEN.id, mode: 'inherit' } })
  emit({ type: 'chat_aside_result', paneId: '%7', requestId: client.last('chat_aside')!.requestId, ok: true })
  await settle()
  fireEvent.press(screen.getByLabelText('Aside actions'))
  fireEvent.press(screen.getByLabelText('Refork'))
  expect(client.sent.filter((message) => message.type === 'chat_aside')).toHaveLength(1)
  const buttons = alert.mock.calls.at(-1)![2]!
  act(() => buttons.find((button) => button.text === 'Refork')!.onPress!())
  expect(client.last('chat_aside')).toMatchObject({ action: { action: 'refork', asideId: OPEN.id } })
})
it('drafts the web prompt, accepts edits, queues the report for Main and closes by default', async () => {
  const { client, emit } = setup()
  await report()
  expect(client.last('chat_send')).toMatchObject({ paneId: KEY, text: ASIDE_REPORT_PROMPT })
  expect(screen.getByText('Drafting…')).toBeTruthy()
  expect(screen.getByLabelText('Close aside after sending').props.value).toBe(true)
  finishReport(emit)
  await settle()
  expect(screen.getByLabelText('Report text').props.value).toBe('A concrete finding')
  fireEvent.changeText(screen.getByLabelText('Report text'), 'Edited finding')
  fireEvent.press(screen.getByLabelText('Send to Main'))
  expect(client.last('chat_send')).toMatchObject({ paneId: '%7', delivery: 'queue', text: asideReportText({ asideId: OPEN.id, title: OPEN.title, body: 'Edited finding' }) })
  expect(client.last('chat_aside')).toMatchObject({ action: { action: 'close', asideId: OPEN.id } })
})
it('places a report beside an existing Main draft, leaving the aside open when requested', async () => {
  const { client, emit } = setup()
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Existing Main draft')
  await report()
  finishReport(emit)
  await settle()
  fireEvent.press(screen.getByLabelText("Put in Main's composer as a draft"))
  fireEvent(screen.getByLabelText('Close aside after sending'), 'valueChange', false)
  fireEvent.press(screen.getByLabelText('Send to Main'))
  await settle()
  expect(screen.getByTestId('chat-input').props.value).toContain('Existing Main draft\n\n**From aside')
  expect(screen.getByTestId('chat-input').props.value).toContain('A concrete finding')
  expect(client.last('chat_aside')).toBeUndefined()
  expect(client.sent.filter((message) => message.type === 'chat_send')).toHaveLength(1)
})
it('shows a clean queued report preview while preserving its envelope for editing', () => {
  const text = asideReportText({ asideId: OPEN.id, title: OPEN.title, body: 'Queue headline\n- Detailed finding' })
  setup({ ...mainChat(), session: { ...mainChat().session, status: 'running', queue: [{ id: 'report-queue', text }] } })
  expect(screen.getByText(`From aside “${OPEN.title}”: Queue headline`)).toBeTruthy()
  expect(screen.queryByText(/<!--/)).toBeNull()
  fireEvent.press(screen.getByLabelText('Edit queued message'))
  expect(screen.getByLabelText('Edit queued message').props.value).toBe(text)
})
it('restores a refused queued report to Main and lets users write after drafting disconnects', async () => {
  const { client, emit } = setup()
  await report()
  emit({ type: 'error', requestId: client.last('chat_send')!.requestId, code: 'refused', message: 'Prompt refused' })
  await settle()
  expect(screen.getByText('Prompt refused')).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('Report text'), 'Manual report')
  fireEvent(screen.getByLabelText('Close aside after sending'), 'valueChange', false)
  fireEvent.press(screen.getByLabelText('Send to Main'))
  const requestId = client.last('chat_send')!.requestId
  emit({ type: 'error', requestId, code: 'refused', message: 'Main unavailable' })
  await settle()
  expect(screen.getByTestId('chat-input').props.value).toContain('Manual report')
  expect(screen.getByText(/report was restored to Main/)).toBeTruthy()
})
it('renders report envelopes as From aside bubbles with Open aside routing', () => {
  setup({ ...mainChat(), items: [item('user_message', { text: asideReportText({ asideId: OPEN.id, title: OPEN.title, body: 'Layout report' }) })] })
  expect(screen.getByText('From aside')).toBeTruthy()
  expect(screen.getAllByText('Investigate layout')).toHaveLength(2)
  fireEvent.press(screen.getByLabelText('Open aside Investigate layout'))
  expect(screen.getByText('Aside answer')).toBeTruthy()
})
it.each(['promoted', 'discarded', 'ephemeral'] as const)('never offers to reopen a %s report source', (state) => {
  const alert = jest.spyOn(Alert, 'alert')
  setup({ ...mainChat(), asides: [{ ...OPEN, ...(state === 'ephemeral' ? { ephemeral: true as const } : { status: state }) }],
    items: [item('user_message', { text: asideReportText({ asideId: OPEN.id, title: OPEN.title, body: 'Finding' }) })] })
  fireEvent.press(screen.getByLabelText(`Open aside ${OPEN.title}`))
  expect(alert).toHaveBeenCalledWith(`From aside “${OPEN.title}”`, state === 'promoted' ? 'Opened as chat' : 'This aside is unavailable.')
  expect(screen.queryByText('Aside answer')).toBeNull()
})
it('keeps older hosts on Main with no aside affordances', () => {
  setup({ ...mainChat(), session: session({ hostVersion: CHAT_ASIDES_HOST_VERSION - 1 }) })
  expect(screen.queryByLabelText('+ Aside')).toBeNull()
  expect(screen.queryByLabelText('Send as aside: Send as aside')).toBeNull()
})

it('routes answers, settings, Stop, queue and full history to the selected aside', () => {
  const { client } = setup(mainChat(), { ...asideChat(), omittedItems: 30, session: session({ paneId: KEY, hostVersion: CHAT_ASIDES_HOST_VERSION, status: 'running', aside: { ...OPEN, parentPaneId: '%7', mode: 'inherit' } }), items: [
    item('request', { requestId: 'approve-edit', requestKind: 'approval', toolName: 'Edit', title: 'Allow edit?', status: 'running' }),
  ] })
  fireEvent.press(screen.getByLabelText('Investigate layout, needs answer'))
  fireEvent.press(screen.getByRole('button', { name: 'Allow once' }))
  expect(client.last('chat_answer')).toMatchObject({ paneId: KEY, chatRequestId: 'approve-edit' })
  fireEvent.changeText(screen.getByTestId('chat-input'), '/plan')
  // Native slash commands configure the selected thread, rather than Main.
  fireEvent(screen.getByTestId('chat-input'), 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } })
  fireEvent.press(screen.getByText('/plan'))
  expect(client.last('chat_configure')).toMatchObject({ paneId: KEY })
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Later check')
  fireEvent.press(screen.getByLabelText('Queue'))
  expect(client.last('chat_send')).toMatchObject({ paneId: KEY, delivery: 'queue' })
  fireEvent.press(screen.getByLabelText('Stop'))
  expect(client.last('chat_interrupt')).toMatchObject({ paneId: KEY })
  fireEvent.press(screen.getByTestId('chat-load-earlier'))
  expect(client.last('chat_history')).toMatchObject({ paneId: KEY })
})
it('waits for the drafting turn to finish and ignores unrelated assistant messages', async () => {
  const { emit } = setup()
  await report()
  emit({ type: 'chat_items', paneId: KEY, items: [
    item('user_message', { text: ASIDE_REPORT_PROMPT, turnId: 'drafting' }),
    item('assistant_message', { text: 'Wrong turn', turnId: 'different' }),
    item('assistant_message', { id: 'streamed-report', text: 'Partial', turnId: 'drafting', status: 'running' }),
  ] })
  emit({ type: 'chat_session', paneId: KEY, session: { ...asideChat().session, status: 'running' }, hostConnected: true })
  expect(screen.getByText('Drafting…')).toBeTruthy()
  emit({ type: 'chat_items', paneId: KEY, items: [item('assistant_message', { id: 'streamed-report', text: 'Completed report', turnId: 'drafting' })] })
  expect(screen.getByText('Drafting…')).toBeTruthy()
  emit({ type: 'chat_session', paneId: KEY, session: asideChat().session, hostConnected: true })
  expect(screen.getByLabelText('Report text').props.value).toBe('Completed report')
})
it('waits when the report source disappears, and does not deliver when cancelled', async () => {
  const { client, emit } = setup()
  await report()
  emit({ type: 'chat_removed', paneId: KEY })
  await settle()
  expect(screen.getByText('Waiting for the aside to reconnect…')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('Write it myself'))
  fireEvent.changeText(screen.getByLabelText('Report text'), 'Keep locally')
  fireEvent.press(screen.getByLabelText('Cancel'))
  expect(screen.queryByLabelText('Report text')).toBeNull()
  expect(client.sent.filter((message) => message.type === 'chat_send')).toHaveLength(1)
})


it('uses Main for new-aside file searches, disables configuration, and preserves independent drafts', async () => {
  const { client } = setup()
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Main draft stays here')
  fireEvent.press(screen.getByLabelText('+ Aside'))
  expect(screen.getByTestId('chat-input').props.value).not.toBe('Main draft stays here')
  fireEvent.changeText(screen.getByTestId('chat-input'), '@src')
  fireEvent(screen.getByTestId('chat-input'), 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } })
  await act(async () => { jest.advanceTimersByTime(100) })
  expect(client.last('chat_file_search')).toMatchObject({ paneId: '%7', query: 'src' })
  fireEvent.changeText(screen.getByTestId('chat-input'), '/model')
  fireEvent(screen.getByTestId('chat-input'), 'selectionChange', { nativeEvent: { selection: { start: 6, end: 6 } } })
  expect(screen.queryByText('/model')).toBeNull()
  fireEvent.changeText(screen.getByTestId('chat-input'), '/plan')
  fireEvent(screen.getByTestId('chat-input'), 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } })
  expect(screen.queryByText('/plan')).toBeNull()
  expect(screen.queryByLabelText(/^Permissions:/)).toBeNull()
  expect(client.last('chat_configure')).toBeUndefined()
  expect(client.sent.every((message) => !('paneId' in message) || message.paneId === '%7')).toBe(true)
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Independent aside draft')
  fireEvent.press(screen.getByLabelText('Main, idle'))
  expect(screen.getByTestId('chat-input').props.value).toBe('Main draft stays here')
  fireEvent.press(screen.getByLabelText('+ Aside'))
  expect(screen.getByTestId('chat-input').props.value).toBe('Independent aside draft')
})

it('disables the composer during aside creation without claiming the host disconnected', async () => {
  const { client, emit } = setup()
  fireEvent.press(screen.getByLabelText('+ Aside'))
  fireEvent.changeText(screen.getByTestId('chat-input'), 'Open slowly')
  fireEvent.press(screen.getByLabelText('Send aside'))
  await settle()
  expect(screen.getByLabelText('Send aside')).toBeDisabled()
  expect(screen.queryByText(/The agent host is disconnected/)).toBeNull()
  expect(screen.getByTestId('chat-input').props.placeholder).not.toContain('Reconnecting')
  emit({ type: 'chat_aside_result', paneId: '%7', requestId: client.last('chat_aside')!.requestId, ok: false, error: 'Try later' })
  await settle()
  expect(screen.getByLabelText('Send aside')).not.toBeDisabled()
})

it.each(['host', 'socket'] as const)('keeps drafting through a brief %s disconnect and accepts the completed report', async (kind) => {
  const { emit, setPhase } = setup()
  await report()
  emit({ type: 'chat_session', paneId: KEY, session: { ...asideChat().session, status: 'running' }, hostConnected: true })
  const target = asideChat()
  if (kind === 'socket') setPhase('reconnecting')
  emit({ type: 'chat_session', paneId: target.paneId, session: target.session, hostConnected: false })
  expect(screen.getByText('Waiting for the aside to reconnect…')).toBeTruthy()
  expect(screen.queryByLabelText('Report text')).toBeNull()
  act(() => jest.advanceTimersByTime(3_000))
  emit({ type: 'chat_session', paneId: target.paneId, session: target.session, hostConnected: true })
  if (kind === 'socket') setPhase('live')
  expect(screen.getByText('Drafting…')).toBeTruthy()
  finishReport(emit)
  await settle()
  expect(screen.getByLabelText('Report text').props.value).toBe('A concrete finding')
})

it.each(['closed', 'error', 'session-change', 'timeout'] as const)('makes a report editable on %s', async (reason) => {
  const { emit } = setup()
  await report()
  if (reason === 'timeout') {
    emit({ type: 'chat_session', paneId: KEY, session: asideChat().session, hostConnected: false })
    act(() => jest.advanceTimersByTime(125_000))
    expect(screen.getByText(/Drafting is taking too long/)).toBeTruthy()
  } else {
    emit({ type: 'chat_session', paneId: KEY, hostConnected: false, session: { ...asideChat().session,
      ...(reason === 'session-change' ? { sessionId: 'replacement' } : { status: reason }) } })
    expect(screen.getByText(/Drafting stopped/)).toBeTruthy()
  }
  expect(screen.getByLabelText('Report text')).toBeTruthy()
})

it('does not re-render for other chats, but updates when this chat’s aside changes', async () => {
  const main = mainChat()
  const renderThread = jest.fn(() => null)
  useChatStore.setState({ byHost: { [HOST.id]: { '%7': main, [KEY]: asideChat() } } })
  render(<ThemeProvider><AsideThreads host={HOST} main={main} phase="live" renderThread={renderThread} /></ThemeProvider>)
  await settle()
  renderThread.mockClear()
  act(() => useChatStore.getState().ingest(HOST.id, { type: 'chat_state', chat: chatState({ paneId: '%70~aside001', session: session({ paneId: '%70~aside001' }) }) }))
  expect(renderThread).not.toHaveBeenCalled()
  act(() => useChatStore.getState().ingest(HOST.id, { type: 'chat_state', chat: { ...asideChat(), session: { ...asideChat().session, title: 'Updated aside' } } }))
  expect(renderThread).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Updated aside, idle')).toBeTruthy()
})

it.each([true, false])('shows a static read-only permission chip (enforced: %s)', (enforced) => {
  const aside = asideChat()
  const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => undefined)
  const { client } = setup(mainChat(), { ...aside, session: { ...aside.session, aside: { ...aside.session.aside!, readOnlyEnforced: enforced } } })
  selectAside()
  const label = enforced ? 'Read-only' : 'Read-only (advisory)'
  expect(screen.getByLabelText(label)).not.toHaveProp('accessibilityRole', 'button')
  expect(screen.queryByLabelText(/^Permissions:/)).toBeNull()
  fireEvent.press(screen.getByLabelText(label))
  expect(sheet).not.toHaveBeenCalled()
  fireEvent.changeText(screen.getByTestId('chat-input'), '/plan')
  fireEvent(screen.getByTestId('chat-input'), 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } })
  expect(screen.queryByText('/plan')).toBeNull()
  expect(client.last('chat_configure')).toBeUndefined()
})

it('keeps permission pickers for Main and full-access asides', () => {
  const aside = asideChat()
  const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => undefined)
  setup(mainChat(), { ...aside, session: { ...aside.session, aside: { ...aside.session.aside!, mode: 'inherit' } } })
  fireEvent.press(screen.getByLabelText('Permissions: Ask before edits'))
  expect(sheet).toHaveBeenCalledTimes(1)
  selectAside()
  fireEvent.press(screen.getByLabelText('Permissions: Ask before edits'))
  expect(sheet).toHaveBeenCalledTimes(2)
})

it('keeps the aside toggle outside scrolling settings and reserves space for running actions', () => {
  setup({ ...mainChat(), session: { ...mainChat().session, status: 'running' } })
  const toggle = screen.getByLabelText('Send as aside: Send as aside')
  expect(within(screen.getByTestId('chat-composer-controls')).getByLabelText('Send as aside: Send as aside') === toggle).toBe(true)
  expect(StyleSheet.flatten(toggle.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 })
  expect(screen.getByText('Send as aside')).toHaveProp('numberOfLines', 1)
  for (const label of ['Stop', 'Steer now', 'Queue']) expect(StyleSheet.flatten(screen.getByLabelText(label).props.style).flexShrink).toBe(0)
  fireEvent.press(toggle)
  expect(StyleSheet.flatten(screen.getByLabelText('Send as aside: Send as aside').props.style).borderColor).toBe(THEMES.purple.cyan)
})

it('uses cyan for selected asides and the banner, retaining Main’s accent', () => {
  setup()
  expect(StyleSheet.flatten(screen.getByLabelText('Main, idle').props.style).borderColor).toBe(THEMES.purple.accent)
  selectAside()
  expect(StyleSheet.flatten(screen.getByLabelText('Investigate layout, idle').props.style).borderColor).toBe(THEMES.purple.cyan)
  expect(screen.getByText(/Aside · forked/)).toHaveStyle({ color: THEMES.purple.cyan })
})

it('uses content-sized modal sheets, insets Cancel, and fills the Send to Main action', async () => {
  const { emit } = setup()
  selectAside()
  fireEvent.press(screen.getByLabelText('Aside actions'))
  const actions = screen.getByTestId('aside-sheet')
  expect(actions).toHaveProp('accessibilityViewIsModal', true)
  expect(StyleSheet.flatten(actions.props.style)).toMatchObject({ flexShrink: 1, maxHeight: '100%' })
  expect(StyleSheet.flatten(actions.props.style).flex).toBeUndefined()
  const cancelRow = screen.getByTestId('aside-sheet-header')
  expect(StyleSheet.flatten(cancelRow.props.style).paddingHorizontal).toBe(20)
  fireEvent.press(screen.getByLabelText('Report to Main'))
  expect(screen.getByTestId('aside-sheet')).toHaveProp('accessibilityViewIsModal', true)
  finishReport(emit)
  await settle()
  expect(screen.getByLabelText('Send to Main')).not.toBeDisabled()
  expect(StyleSheet.flatten(screen.getByLabelText('Send to Main').props.style).backgroundColor).toBe(THEMES.purple.cyan)
})


it('keeps Main’s tile cards and external runs out of the new-aside timeline', () => {
  const { emit } = setup()
  emit({ type: 'chat_tile_events', paneId: '%7', events: [{ id: 'main-card', kind: 'opened', paneId: '%7', webPaneId: 'wp-main', source: 'canvas', title: 'Main layout', fileName: 'canvas.json', at: 1000 }] })
  emit({ type: 'chat_external_runs', paneId: '%7', runs: [{ id: 'main-run', runtime: 'codex', label: 'Main agent task', state: 'running', startedAt: 1000, updatedAt: 1000 }] })
  expect(screen.getByText('Main layout')).toBeTruthy()
  fireEvent.press(screen.getByLabelText('+ Aside'))
  expect(screen.queryByTestId('tile-event-card')).toBeNull()
  expect(screen.queryByText(/Main agent task/)).toBeNull()
  expect(screen.queryByText('Main question')).toBeNull()
})
