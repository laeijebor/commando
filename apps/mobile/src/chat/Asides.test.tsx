import { Alert } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { ASIDE_REPORT_PROMPT, CHAT_ASIDES_HOST_VERSION, asideKey, asideReportText, type ChatAsideRecord, type ChatState } from '@commando/agent-chat'
import type { ServerMessage } from '@commando/protocol'
import { ThemeProvider } from '../theme'
import type { Host } from '../hosts/types'
import { createChatRowSelector } from '../ui/chatRowMetadata'
import { parseNotificationData, notificationRoute } from '../notifications/routing'
import { PaneView } from '../terminal/PaneView'
import { threadStatus } from './AsideThreads'
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

function setup(main = mainChat(), aside: ChatState | null = asideChat()) {
  const client = fakeClient()
  const emit = (message: ServerMessage) => act(() => client.emit(message))
  client.subscribe((message) => useChatStore.getState().ingest(HOST.id, message))
  useChatStore.getState().ingest(HOST.id, { type: 'chat_snapshot', chats: [main, ...(aside ? [aside] : [])] })
  function Harness() {
    const chat = useChat(HOST.id, '%7')!
    return <ThemeProvider><ChatView host={HOST} chat={chat} client={client} phase="live" /></ThemeProvider>
  }
  render(<Harness />)
  return { client, emit }
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
  expect(screen.getByText('From aside “Investigate layout”')).toBeTruthy()
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
  const { client } = setup(mainChat(), { ...asideChat(), omittedItems: 30, session: session({ paneId: KEY, hostVersion: CHAT_ASIDES_HOST_VERSION, status: 'running' }), items: [
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
it('makes a disconnected report editable and does not deliver when it is cancelled', async () => {
  const { client, emit } = setup()
  await report()
  emit({ type: 'chat_removed', paneId: KEY })
  await settle()
  expect(screen.getByText(/Drafting stopped or the aside disconnected/)).toBeTruthy()
  fireEvent.changeText(screen.getByLabelText('Report text'), 'Keep locally')
  fireEvent.press(screen.getByLabelText('Cancel'))
  expect(screen.queryByLabelText('Report text')).toBeNull()
  expect(client.sent.filter((message) => message.type === 'chat_send')).toHaveLength(1)
})
