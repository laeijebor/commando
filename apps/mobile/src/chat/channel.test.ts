import { ChatChannel } from './channel'
import { fakeClient } from './testing'

const channels: ChatChannel[] = []

function setup(open = true) {
  const client = fakeClient({ open })
  const sendRefused = jest.fn()
  const actionRefused = jest.fn()
  const channel = new ChatChannel(client, '%7', { sendRefused, actionRefused })
  client.subscribe((message) => channel.receive(message))
  channels.push(channel)
  return { client, channel, sendRefused, actionRefused }
}

describe('the chat channel', () => {
  afterEach(() => {
    for (const channel of channels.splice(0)) channel.dispose()
    jest.useRealTimers()
  })

  it('sends the same messages the web does', () => {
    const { client, channel } = setup()
    channel.send('hi', [{ id: `${'a'.repeat(64)}.png`, name: 'shot.png' }], { delivery: 'queue' })
    channel.interrupt(['q1'])
    channel.answer('req-1', { kind: 'approval', decision: 'allow' })
    channel.configure({ effort: 'low' })
    channel.queue({ action: 'steer', id: 'q1' })
    expect(client.sent.map(({ requestId: _id, ...message }) => message)).toEqual([
      { type: 'chat_send', paneId: '%7', text: 'hi', images: [{ id: `${'a'.repeat(64)}.png`, name: 'shot.png' }], delivery: 'queue' },
      { type: 'chat_interrupt', paneId: '%7', dropQueued: ['q1'] },
      { type: 'chat_answer', paneId: '%7', chatRequestId: 'req-1', answer: { kind: 'approval', decision: 'allow' } },
      { type: 'chat_configure', paneId: '%7', settings: { effort: 'low' } },
      { type: 'chat_queue', paneId: '%7', action: 'steer', id: 'q1' },
    ])
  })

  it('names refused sends by request id, collecting refusals until the next send', () => {
    const { client, channel, sendRefused } = setup()
    const first = channel.send('one')
    const second = channel.send('two')
    client.emit({ type: 'error', code: 'chat_image_missing', message: 'gone', requestId: first })
    client.emit({ type: 'error', code: 'chat_unavailable', message: 'No host', requestId: second })
    expect(sendRefused).toHaveBeenLastCalledWith({ message: 'No host', refused: [{ requestId: first, code: 'chat_image_missing' }, { requestId: second, code: 'chat_unavailable' }] })
    channel.send('three')
    expect(sendRefused).toHaveBeenLastCalledWith(null)
    // An error for nothing this pane sent is someone else's.
    client.emit({ type: 'error', code: 'x', message: 'other', requestId: 'elsewhere' })
    expect(sendRefused).toHaveBeenCalledTimes(3)
  })

  it('reports a send or action the socket could not take', () => {
    const { channel, sendRefused, actionRefused } = setup(false)
    const id = channel.send('hi')
    expect(sendRefused).toHaveBeenCalledWith({ message: expect.stringContaining('Not connected'), refused: [{ requestId: id }] })
    channel.interrupt()
    expect(actionRefused).toHaveBeenCalledWith(expect.stringContaining('Not connected'))
  })

  it('passes a refused action on', () => {
    const { client, channel, actionRefused } = setup()
    channel.answer('req-1', { kind: 'approval', decision: 'deny' })
    client.emit({ type: 'error', code: 'chat_unavailable', message: 'Already answered on another device', requestId: client.last('chat_answer')!.requestId })
    expect(actionRefused).toHaveBeenCalledWith('Already answered on another device')
  })

  it('answers a file search from its result, an error or a timeout', async () => {
    jest.useFakeTimers()
    const { client, channel } = setup()
    const found = channel.searchFiles('src')
    client.emit({ type: 'chat_file_search_result', paneId: '%7', requestId: client.last('chat_file_search')!.requestId, entries: [{ path: 'src', kind: 'directory' }], truncated: false })
    await expect(found).resolves.toEqual({ entries: [{ path: 'src', kind: 'directory' }], truncated: false })
    const failed = channel.searchFiles('x')
    client.emit({ type: 'error', code: 'chat_unavailable', message: 'No host', requestId: client.last('chat_file_search')!.requestId })
    await expect(failed).resolves.toMatchObject({ entries: [], error: 'No host' })
    const slow = channel.searchFiles('y')
    jest.advanceTimersByTime(15_000)
    await expect(slow).resolves.toMatchObject({ error: 'The file search timed out' })
  })
})
