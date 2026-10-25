import { ActionSheetIOS, StyleSheet } from 'react-native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

import type { ChatState } from '@commando/agent-chat'

import type { Host } from '../hosts/types'
import { ThemeProvider } from '../theme'
import { ChatView } from './ChatView'
import { ChatTimeline } from './ChatTimeline'
import { chatState, fakeClient, item, session } from './testing'

const HOST: Host = { id: 'host-1', name: 'studio', baseUrl: 'http://studio:4310', auth: { kind: 'token', token: 'secret' } }

function renderChat(chat: ChatState, client = fakeClient()) {
  const view = render(
    <ThemeProvider>
      <ChatView chat={chat} client={client} host={HOST} phase="live" />
    </ThemeProvider>,
  )
  return { client, rerender: (next: ChatState) => view.rerender(<ThemeProvider><ChatView chat={next} client={client} host={HOST} phase="live" /></ThemeProvider>) }
}

async function settle(): Promise<void> {
  await act(async () => undefined)
}

describe('the phone chat view', () => {
  it.each(['codex', 'cursor', 'muse', 'future'])('uses %s presentation throughout a chat', async (provider) => {
    const name = provider === 'future' ? 'Agent' : provider.charAt(0).toUpperCase() + provider.slice(1)
    renderChat(chatState({ session: session({ provider: provider as ChatState['session']['provider'] }) }))
    await settle()
    expect(screen.getByLabelText(`Message ${name}`)).toBeTruthy()
    expect(screen.getByPlaceholderText(`Ask ${name}… / for commands, @ for files`)).toBeTruthy()
    expect(screen.getByText(`Ask ${name} anything about this folder.`)).toBeTruthy()
  })

  it('draws the conversation: messages, a collapsed work group, a thought and a plan', async () => {
    renderChat(chatState({
      items: [
        item('user_message', { text: 'Where does the HUD card get its attention line?' }),
        item('reasoning', { text: 'Looking at the registry', createdAt: 1_000, updatedAt: 15_000 }),
        item('tool', { toolUseId: 'u1', toolName: 'Read', title: 'Read /Users/me/dev/commando/src/AgentHudCard.tsx' }),
        item('tool', { toolUseId: 'u2', toolName: 'Grep', title: 'Grep answerAgentRequest' }),
        item('file_change', { toolUseId: 'u3', toolName: 'Edit', path: '/Users/me/dev/commando/src/AgentHudCard.tsx', additions: 4, deletions: 1 }),
        item('assistant_message', { text: 'From **details.attention**, set by the hook:\n\n```ts\nconst attention = details.attention ?? status.summary // a long line that scrolls\n```' }),
        item('plan', { toolUseId: 'p1', text: '# Add approvals\n\n- Deny\n- Allow once' }),
      ],
    }))
    await settle()
    expect(screen.getByText('Where does the HUD card get its attention line?')).toBeTruthy()
    expect(screen.getByText('Edited 1 file, read 1 file, searched 1 time')).toBeTruthy()
    expect(screen.getByText('details.attention')).toBeTruthy()
    // Code keeps its lines and scrolls sideways.
    const code = screen.getByTestId('chat-code-scroll')
    expect(code.props.horizontal).toBe(true)
    expect(screen.getByText(/const attention = details\.attention/)).toBeTruthy()
    expect(screen.getByText('Add approvals')).toBeTruthy()

    // Thinking now shares the desktop's collapsed activity summary.
    fireEvent.press(screen.getByText('Edited 1 file, read 1 file, searched 1 time'))
    expect(screen.getByText('Thought for 14s')).toBeTruthy()
    expect(screen.getByText('Edited src/AgentHudCard.tsx')).toBeTruthy()
  })

  it('sends when idle, queues while Claude works, and steers on request', async () => {
    const { client, rerender } = renderChat(chatState())
    await settle()
    fireEvent.changeText(screen.getByTestId('chat-input'), 'Add the buttons')
    fireEvent.press(screen.getByLabelText('Send'))
    expect(client.last('chat_send')).toMatchObject({ type: 'chat_send', paneId: '%7', text: 'Add the buttons' })
    expect(client.last('chat_send')).not.toHaveProperty('delivery')

    rerender(chatState({ session: session({ status: 'running' }) }))
    fireEvent.changeText(screen.getByTestId('chat-input'), 'and run the tests')
    fireEvent.press(screen.getByLabelText('Queue'))
    expect(client.last('chat_send')).toMatchObject({ text: 'and run the tests', delivery: 'queue' })

    fireEvent.changeText(screen.getByTestId('chat-input'), 'stop and look at this')
    fireEvent.press(screen.getByLabelText('Steer now'))
    expect(client.last('chat_send')).toMatchObject({ text: 'stop and look at this', delivery: 'steer' })
  })

  it('edits, removes and steers queued messages, and Stop brings them back', async () => {
    const queue = [{ id: 'q1', text: 'first follow-up' }, { id: 'q2', text: 'second' }]
    const { client } = renderChat(chatState({ session: session({ status: 'running', queue }) }))
    await settle()
    expect(screen.getByText('first follow-up')).toBeTruthy()
    fireEvent.press(screen.getAllByLabelText('Steer')[0]!)
    expect(client.last('chat_queue')).toMatchObject({ action: 'steer', id: 'q1' })
    fireEvent.press(screen.getAllByLabelText('Remove queued message')[1]!)
    expect(client.last('chat_queue')).toMatchObject({ action: 'remove', id: 'q2' })
    fireEvent.press(screen.getAllByLabelText('Edit queued message')[0]!)
    fireEvent.changeText(screen.getByDisplayValue('first follow-up'), 'first, edited')
    fireEvent.press(screen.getByLabelText('Save'))
    expect(client.last('chat_queue')).toMatchObject({ action: 'edit', id: 'q1', text: 'first, edited' })

    fireEvent.press(screen.getByLabelText('Stop'))
    expect(client.last('chat_interrupt')).toMatchObject({ dropQueued: ['q1', 'q2'] })
    expect(screen.getByTestId('chat-input').props.value).toBe('first follow-up\n\nsecond')
  })

  it('answers an approval inline', async () => {
    const { client } = renderChat(chatState({
      session: session({ status: 'waiting' }),
      items: [item('request', { requestId: 'req-1', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'npm test -- hud', status: 'running' })],
    }))
    await settle()
    expect(screen.getByText('PERMISSION REQUEST')).toBeTruthy()
    expect(screen.getByText('npm test -- hud')).toBeTruthy()
    fireEvent.press(screen.getByText('Allow once'))
    expect(client.last('chat_answer')).toMatchObject({ chatRequestId: 'req-1', answer: { kind: 'approval', decision: 'allow' } })
  })

  it('shows why Claude asks and hides Always when Claude refuses one', async () => {
    renderChat(chatState({
      session: session({ status: 'waiting' }),
      items: [item('request', { requestId: 'req-3', requestKind: 'approval', toolName: 'Bash', title: 'Allow Bash?', detail: 'rm -f f/*', reason: 'Safety check: Dangerous rm operation', noAlwaysAllow: true, status: 'running' })],
    }))
    await settle()
    expect(screen.getByText('Safety check: Dangerous rm operation')).toBeTruthy()
    expect(screen.queryByText('Always')).toBeNull()
    expect(screen.getByText('Allow once')).toBeTruthy()
  })

  it('answers a question inline', async () => {
    const { client } = renderChat(chatState({
      session: session({ status: 'waiting' }),
      items: [item('request', {
        requestId: 'req-2',
        requestKind: 'question',
        toolName: 'AskUserQuestion',
        title: 'Claude is asking',
        status: 'running',
        questions: [{ question: 'Which layout?', options: [{ label: 'Stacked' }, { label: 'Side by side' }], multiSelect: false }],
      })],
    }))
    await settle()
    expect(screen.getByRole('button', { name: 'Answer' })).toBeDisabled()
    fireEvent.press(screen.getByText('Side by side'))
    fireEvent.press(screen.getByRole('button', { name: 'Answer' }))
    expect(client.last('chat_answer')).toMatchObject({ chatRequestId: 'req-2', answer: { kind: 'question', answers: { 'Which layout?': 'Side by side' } } })
  })

  it('opens the / menu and puts the picked command in the draft', async () => {
    renderChat(chatState({ commands: [{ name: 'compact', description: 'Compact the conversation', kind: 'command' }, { name: 'review', description: 'Review a PR', kind: 'skill' }] }))
    await settle()
    const input = screen.getByTestId('chat-input')
    fireEvent.changeText(input, '/rev')
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 4, end: 4 } } })
    fireEvent.press(screen.getByText('/review'))
    expect(screen.getByTestId('chat-input').props.value).toBe('/review ')
  })

  it('searches files for @ and inserts the mention', async () => {
    jest.useFakeTimers()
    const { client } = renderChat(chatState())
    await settle()
    const input = screen.getByTestId('chat-input')
    fireEvent.changeText(input, 'look at @src/Ag')
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 15, end: 15 } } })
    await act(async () => { jest.advanceTimersByTime(100) })
    const search = client.last('chat_file_search')
    expect(search).toMatchObject({ query: 'src/Ag' })
    await act(async () => {
      client.emit({ type: 'chat_file_search_result', paneId: '%7', requestId: search!.requestId, entries: [{ path: 'src/AgentHudCard.tsx', kind: 'file' }], truncated: false })
    })
    fireEvent.press(screen.getByText('src/AgentHudCard.tsx'))
    expect(screen.getByTestId('chat-input').props.value).toBe('look at @src/AgentHudCard.tsx ')
    jest.useRealTimers()
  })

  it('puts a refused send back in the draft with the reason', async () => {
    const { client } = renderChat(chatState())
    await settle()
    fireEvent.changeText(screen.getByTestId('chat-input'), 'hello')
    fireEvent.press(screen.getByLabelText('Send'))
    await act(async () => {
      client.emit({ type: 'error', code: 'chat_unavailable', message: 'No agent host is connected for this pane', requestId: client.last('chat_send')!.requestId })
    })
    expect(screen.getByText('No agent host is connected for this pane')).toBeTruthy()
    expect(screen.getByTestId('chat-input').props.value).toBe('hello')
  })

  it('switches the permission mode from its native menu', async () => {
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
      callback(options.options.findIndex((option) => option === 'Plan mode'))
    })
    const { client } = renderChat(chatState())
    await settle()
    await act(async () => { fireEvent.press(screen.getByLabelText('Permissions: Ask before edits')) })
    expect(sheet.mock.calls[0]![0].options).toEqual(['✓ Ask before edits', 'Accept edits', 'Plan mode', 'Cancel'])
    expect(client.last('chat_configure')).toMatchObject({ settings: { permissionMode: 'plan' } })
    sheet.mockRestore()
  })
})

it('bounds the list viewport and keeps the composer dock below it in the same flex column', async () => {
  renderChat(chatState({ items: [item('user_message', { text: 'Keep the latest reply visible' }), item('assistant_message', { text: 'A reply inside the viewport.' })] }))
  await settle()
  const root = screen.getByTestId('chat-view')
  const viewport = screen.getByTestId('chat-timeline-viewport')
  const list = screen.getByTestId('chat-timeline')
  const dock = screen.getByTestId('chat-composer-dock')
  expect(root).toHaveStyle({ flex: 1, height: 0, minHeight: 0 })
  expect(viewport).toHaveStyle({ flex: 1, height: 0, minHeight: 0 })
  expect(list).toHaveStyle({ flex: 1, height: 0, minHeight: 0 })
  expect(dock).toHaveStyle({ flexShrink: 0 })
  expect(StyleSheet.flatten(list.props.contentContainerStyle).flexGrow).toBeUndefined()
  const hostParent = (node: ReturnType<typeof screen.getByTestId>) => {
    let parent = node.parent
    while (parent && typeof parent.type !== 'string') parent = parent.parent
    return parent
  }
  expect(hostParent(viewport)).toBe(root)
  expect(hostParent(dock)).toBe(root)
  const children = root.props.children as { type?: unknown; props?: { testID?: string } }[]
  const timelineIndex = children.findIndex((child) => child?.type === ChatTimeline)
  const dockIndex = children.findIndex((child) => child?.props?.testID === 'chat-composer-dock')
  expect(timelineIndex).toBeGreaterThanOrEqual(0)
  expect(dockIndex).toBeGreaterThan(timelineIndex)
})

describe('a reconnect under a draft', () => {
  function renderPhase(chat: ChatState, phase: 'live' | 'reconnecting') {
    return <ThemeProvider><ChatView chat={chat} client={fakeClient()} host={HOST} phase={phase} /></ThemeProvider>
  }

  it('keeps the same editable field and the draft, and stays quiet when it is quick', async () => {
    const client = fakeClient()
    const view = render(<ThemeProvider><ChatView chat={chatState()} client={client} host={HOST} phase="live" /></ThemeProvider>)
    await settle()
    const field = screen.getByTestId('chat-input')
    fireEvent.changeText(field, 'Half a thought about the')

    jest.useFakeTimers()
    try {
      // The socket drops; the daemon's reconnect snapshot then replaces the chat object.
      view.rerender(<ThemeProvider><ChatView chat={chatState()} client={client} host={HOST} phase="reconnecting" /></ThemeProvider>)
      expect(screen.getByTestId('chat-input')).toBe(field)
      expect(field.props.editable).not.toBe(false)
      expect(screen.queryByText(/Reconnecting to Commando/)).toBeNull()
      act(() => { jest.advanceTimersByTime(1_000) })
      view.rerender(<ThemeProvider><ChatView chat={chatState()} client={client} host={HOST} phase="live" /></ThemeProvider>)
    } finally {
      jest.useRealTimers()
    }

    // Same host instance: the field was never unmounted or remounted, so iOS
    // never resigned it, and it was never read-only, so the keyboard stayed up.
    expect(screen.getByTestId('chat-input')).toBe(field)
    expect(field.props.editable).not.toBe(false)
    expect(field.props.value).toBe('Half a thought about the')
    expect(screen.queryByText(/Reconnecting to Commando/)).toBeNull()
  })

  it('says it is reconnecting after a grace period, still taking typing but not sends', async () => {
    jest.useFakeTimers()
    try {
      const view = render(renderPhase(chatState(), 'live'))
      fireEvent.changeText(screen.getByTestId('chat-input'), 'Draft')
      view.rerender(renderPhase(chatState(), 'reconnecting'))
      act(() => { jest.advanceTimersByTime(2_000) })
      expect(screen.getByText(/Reconnecting to Commando/)).toBeTruthy()
      const field = screen.getByTestId('chat-input')
      expect(field.props.editable).not.toBe(false)
      fireEvent.changeText(field, 'Draft, still typing')
      expect(screen.getByTestId('chat-input').props.value).toBe('Draft, still typing')
      expect(screen.getByLabelText('Send')).toBeDisabled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('offers the history the daemon left out, and asks for it', async () => {
    const client = fakeClient()
    render(<ThemeProvider><ChatView chat={chatState({ omittedItems: 120, items: [item('user_message', { text: 'Latest' })] })} client={client} host={HOST} phase="live" /></ThemeProvider>)
    await settle()
    fireEvent.press(screen.getByLabelText('Load 120 earlier items'))
    expect(client.last('chat_history')).toMatchObject({ type: 'chat_history', paneId: '%7' })
  })
})
