import { MAX_PASTE_BYTES } from '@commando/protocol'

import {
  composerOps,
  keyBarOps,
  rawOps,
  sendComposer,
  sendOps,
  type PaneSender,
} from './composerOps'
import { KEY_BAR_ITEMS, keyBarItem } from './keyBarItems'

function fakeClient(): PaneSender & {
  calls: string[]
  paste: jest.Mock
  input: jest.Mock
  key: jest.Mock
} {
  const calls: string[] = []
  return {
    calls,
    paste: jest.fn((_paneId: string, data: string) => {
      calls.push(`paste:${data}`)
      return 'r1'
    }),
    input: jest.fn((_paneId: string, data: string) => {
      calls.push(`input:${data}`)
      return 'r2'
    }),
    key: jest.fn((_paneId: string, key: string) => {
      calls.push(`key:${key}`)
      return 'r3'
    }),
  }
}

describe('the composer in prompt mode', () => {
  it('sends the whole message as one paste, then Enter', () => {
    const client = fakeClient()
    expect(sendComposer(client, '%1', 'first line\nsecond line', 'prompt')).toBe('sent')
    expect(client.calls).toEqual(['paste:first line\nsecond line', 'key:Enter'])
    expect(client.paste).toHaveBeenCalledWith('%1', 'first line\nsecond line')
    expect(client.key).toHaveBeenCalledWith('%1', 'Enter')
  })

  it('trims the trailing newline so Enter is not sent twice', () => {
    expect(composerOps('ship it\n\n', 'prompt')).toEqual([
      { kind: 'paste', data: 'ship it' },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('does nothing for an empty message', () => {
    const client = fakeClient()
    expect(composerOps('   \n ', 'prompt')).toEqual([])
    expect(sendComposer(client, '%1', '', 'prompt')).toBe('empty')
    expect(client.calls).toEqual([])
  })

  it('refuses a paste the daemon would reject, without sending Enter', () => {
    const client = fakeClient()
    const huge = 'a'.repeat(MAX_PASTE_BYTES + 1)
    expect(sendComposer(client, '%1', huge, 'prompt')).toBe('too-large')
    expect(client.calls).toEqual([])
  })

  it('reports a dropped socket rather than pretending it sent', () => {
    const client = fakeClient()
    client.paste.mockReturnValue(null)
    expect(sendComposer(client, '%1', 'hello', 'prompt')).toBe('offline')
    expect(client.key).not.toHaveBeenCalled()
  })
})

describe('the composer in raw mode', () => {
  it('sends each keystroke as input', () => {
    const client = fakeClient()
    expect(sendComposer(client, '%1', 'q', 'raw')).toBe('sent')
    expect(client.calls).toEqual(['input:q'])
  })

  it('turns newlines into real Enter keys', () => {
    expect(rawOps('yes\n')).toEqual([
      { kind: 'input', data: 'yes' },
      { kind: 'key', key: 'Enter' },
    ])
    expect(rawOps('\n')).toEqual([{ kind: 'key', key: 'Enter' }])
    expect(rawOps('a\nb')).toEqual([
      { kind: 'input', data: 'a' },
      { kind: 'key', key: 'Enter' },
      { kind: 'input', data: 'b' },
    ])
  })

  it('never pastes in raw mode', () => {
    const client = fakeClient()
    sendComposer(client, '%1', 'abc\n', 'raw')
    expect(client.paste).not.toHaveBeenCalled()
  })
})

describe('the key bar', () => {
  it('maps every button to a key, literal input or the clipboard', () => {
    expect(KEY_BAR_ITEMS.map((item) => item.id)).toEqual([
      'esc', 'tab', 'ctrl-c', 'ctrl-d', 'up', 'down', 'left', 'right', 'enter', 'slash', 'paste',
    ])
    expect(keyBarItem('esc')?.action).toEqual({ kind: 'key', key: 'Escape' })
    expect(keyBarItem('tab')?.action).toEqual({ kind: 'key', key: 'Tab' })
    expect(keyBarItem('ctrl-c')?.action).toEqual({ kind: 'key', key: 'C-c' })
    expect(keyBarItem('ctrl-d')?.action).toEqual({ kind: 'key', key: 'C-d' })
    expect(keyBarItem('up')?.action).toEqual({ kind: 'key', key: 'Up' })
    expect(keyBarItem('enter')?.action).toEqual({ kind: 'key', key: 'Enter' })
    // The slash that opens Claude Code's menu is literal input, not a key.
    expect(keyBarItem('slash')?.action).toEqual({ kind: 'input', data: '/' })
    expect(keyBarItem('paste')?.action).toEqual({ kind: 'paste' })
  })

  it('sends a key tap as one key message', () => {
    const client = fakeClient()
    const item = keyBarItem('ctrl-c')
    expect(sendOps(client, '%1', keyBarOps(item!.action))).toBe('sent')
    expect(client.calls).toEqual(['key:C-c'])
  })

  it('pastes what the clipboard held, and nothing when it was empty', () => {
    const client = fakeClient()
    expect(sendOps(client, '%1', keyBarOps({ kind: 'paste' }, 'from the clipboard'))).toBe('sent')
    expect(client.calls).toEqual(['paste:from the clipboard'])
    expect(keyBarOps({ kind: 'paste' }, '')).toEqual([])
    expect(keyBarOps({ kind: 'paste' })).toEqual([])
  })
})
