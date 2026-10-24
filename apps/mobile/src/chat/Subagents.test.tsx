import { Alert } from 'react-native'
import { act, fireEvent, render, screen, within } from '@testing-library/react-native'

import type { ChatItem, ChatState, ExternalAgentRun } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { useChatStore } from './store'
import { chatState, fakeClient, item, session } from './testing'

const HOST: Host = { id: 'host-sub', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }
const NOW = 1_000_000

const subagent = (id: string, fields: Partial<Extract<ChatItem, { kind: 'subagent' }>> = {}) =>
  item('subagent', { id, toolUseId: id, turnId: 'fan', description: `Agent ${id}`, state: 'completed', createdAt: NOW - 90_000, updatedAt: NOW - 30_000, ...fields } as never)

const ITEMS: ChatItem[] = [
  item('user_message', { turnId: 'fan', text: 'Fan out', createdAt: NOW - 100_000 }),
  subagent('map', { agentId: 'agent-map', description: 'Map the views', subagentType: 'Explore', toolUses: 6, durationMs: 94_000, summary: 'Found the rows', prompt: 'Find the subagent rows' }),
  item('tool', { turnId: 'fan', parentToolUseId: 'map', toolUseId: 'm1', toolName: 'Read', title: 'Read src/chat/Subagents.tsx' }),
  item('assistant_message', { turnId: 'fan', parentToolUseId: 'map', text: 'The rows live in Subagents.tsx' }),
  subagent('port', { agentId: 'agent-port', description: 'Port the metrics', state: 'running', status: 'running', background: true, toolUses: 3 }),
  subagent('tests', { agentId: 'agent-tests', description: 'Run the tests', state: 'running', status: 'running' }),
  subagent('ipad', { description: 'Check the iPad', state: 'failed', status: 'failed', toolUses: 2, durationMs: 31_000, updatedAt: NOW - 59_000 }),
  subagent('history', { agentId: 'agent-history', description: 'Read the history' }),
  item('command', { turnId: 'fan', toolUseId: 'cx', command: 'codex exec "Review the rows"', createdAt: NOW - 80_000 }),
]

const RUN: ExternalAgentRun = { id: 'run-codex', runtime: 'codex', label: 'Review the rows', state: 'quiet', startedAt: NOW - 79_000, updatedAt: NOW - 70_000, lastEventAt: NOW - 240_000, model: 'gpt-6.1', toolUses: 9, lastAction: 'Read ChatTimeline.tsx' }

function renderChat(chat: ChatState = chatState({ session: session({ status: 'running' }), items: ITEMS })) {
  const client = fakeClient()
  render(<ThemeProvider><ChatView chat={chat} client={client} host={HOST} phase="live" /></ThemeProvider>)
  return client
}

async function settle(): Promise<void> {
  await act(async () => undefined)
}

/** Presses the destructive button of the last Alert. */
function confirmAlert(alert: jest.SpyInstance) {
  const buttons = alert.mock.calls.at(-1)![2] as { text: string; onPress?: () => void }[]
  act(() => buttons.find((button) => button.text === 'Stop')!.onPress!())
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW })
  useChatStore.setState({ byHost: {}, externalRuns: {} })
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('subagents in the phone chat', () => {
  it('draws each subagent with its state, type and metrics, and ticks elapsed time while live', async () => {
    renderChat()
    await settle()
    expect(screen.getByText('5 subagents · 2 running')).toBeTruthy()
    expect(screen.getByText(/done · 6 tools · 1m 34s · Found the rows/)).toBeTruthy()
    expect(screen.getByText(/background · 3 tools · 1m 30s/)).toBeTruthy()
    expect(screen.getByText(/failed · 2 tools · 31s/)).toBeTruthy()
    expect(screen.getByLabelText('Failed')).toBeTruthy()
    act(() => jest.advanceTimersByTime(5_000))
    expect(screen.getByText(/background · 3 tools · 1m 35s/)).toBeTruthy()
  })

  it('folds external runs into the turn with their quiet time and a confirmed Stop', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    useChatStore.getState().ingest(HOST.id, { type: 'chat_external_runs', paneId: '%7', runs: [RUN] })
    const client = renderChat()
    await settle()
    expect(screen.getByText(/quiet for 4m/)).toBeTruthy()
    expect(screen.getByText(/Codex · gpt-6\.1/)).toBeTruthy()
    // An external run has no transcript to open.
    expect(screen.queryByLabelText('Open subagent Review the rows')).toBeNull()
    fireEvent.press(within(screen.getAllByTestId('subagent-group')[1]!).getByLabelText('Stop Review the rows'))
    expect(alert).toHaveBeenCalledWith('Stop Review the rows?', expect.any(String), expect.any(Array))
    expect(client.last('chat_external_stop')).toBeUndefined()
    confirmAlert(alert)
    expect(client.last('chat_external_stop')).toMatchObject({ paneId: '%7', runId: 'run-codex' })
  })

  it('opens a subagent on its own live turns with a header, and goes back to main', async () => {
    renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Open subagent Map the views'))
    expect(screen.getByTestId('subagent-header')).toBeTruthy()
    expect(screen.getByText('Find the subagent rows')).toBeTruthy()
    expect(screen.getByText('The rows live in Subagents.tsx')).toBeTruthy()
    expect(screen.queryByText('Fan out')).toBeNull()
    expect(screen.getByLabelText('Agents, viewing Map the views, 2 running')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('Back to main'))
    expect(screen.queryByTestId('subagent-header')).toBeNull()
    expect(screen.getByText('Fan out')).toBeTruthy()
  })

  it('reads a finished subagent\'s saved transcript when none of its items are live', async () => {
    const client = renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Open subagent Read the history'))
    const request = client.last('chat_subagent_transcript')!
    expect(request).toMatchObject({ paneId: '%7', agentId: 'agent-history' })
    expect(screen.getByText("Loading the subagent's transcript…")).toBeTruthy()
    await act(async () => client.emit({ type: 'chat_subagent_transcript_result', paneId: '%7', requestId: request.requestId, items: [item('assistant_message', { text: 'Two PRs touched subagents' })] }))
    expect(screen.getByText('Two PRs touched subagents')).toBeTruthy()
  })

  it('switches agents from the sheet, backgrounds a foreground one and stops one after confirming', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const client = renderChat()
    await settle()
    fireEvent.press(screen.getByTestId('agent-switcher'))
    const sheet = within(screen.getByTestId('agent-switcher-sheet'))
    expect(sheet.getByText('Main Claude')).toBeTruthy()
    // Only a foreground SDK subagent can go to the background.
    expect(sheet.queryByLabelText('Background Port the metrics')).toBeNull()
    fireEvent.press(sheet.getByLabelText('Background Run the tests'))
    expect(client.last('chat_task')).toMatchObject({ action: 'background', agentId: 'agent-tests', toolUseId: 'tests' })
    fireEvent.press(sheet.getByLabelText('Stop Port the metrics'))
    confirmAlert(alert)
    expect(client.last('chat_task')).toMatchObject({ action: 'stop', agentId: 'agent-port', toolUseId: 'port' })
    fireEvent.press(sheet.getByLabelText('Port the metrics'))
    expect(screen.getByLabelText('Agents, viewing Port the metrics, 2 running')).toBeTruthy()
  })

  it('relays a message through main Claude, and explains when a running foreground subagent can\'t take one', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const client = renderChat()
    await settle()
    fireEvent.press(screen.getByLabelText('Open subagent Run the tests'))
    fireEvent.press(screen.getByLabelText('Message Run the tests'))
    expect(alert).toHaveBeenCalledWith("Can't message Run the tests yet", 'Background this subagent to message it while it runs')
    expect(screen.queryByTestId('relay-chip')).toBeNull()

    fireEvent.press(screen.getByTestId('agent-switcher'))
    fireEvent.press(within(screen.getByTestId('agent-switcher-sheet')).getByLabelText('Port the metrics'))
    fireEvent.press(screen.getByLabelText('Message Port the metrics'))
    expect(screen.getByTestId('relay-chip')).toBeTruthy()
    expect(screen.getByPlaceholderText('Message @Port the metrics through main Claude…')).toBeTruthy()
    // A relay goes now, so there is no Queue or Steer while Claude works.
    expect(screen.queryByLabelText('Steer now')).toBeNull()
    fireEvent.changeText(screen.getByTestId('chat-input'), 'Keep the warning amber')
    fireEvent.press(screen.getByLabelText('Send'))
    const sent = client.last('chat_send')!
    expect(sent).toMatchObject({ text: 'Keep the warning amber', relayTo: { agentId: 'agent-port', label: 'Port the metrics' } })
    expect(sent).not.toHaveProperty('delivery')
    fireEvent.press(screen.getByLabelText('Stop messaging this subagent'))
    expect(screen.queryByTestId('relay-chip')).toBeNull()
  })
})
