import { afterEach, describe, expect, it, vi } from 'vitest'
import { TmuxControllerPool } from './tmux-control.js'
import { pasteBufferCommands, TmuxClient } from './tmux.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tmux paste dispatch', () => {
  it('loads stdin into a named buffer and pastes it with bracket handling and cleanup', () => {
    expect(pasteBufferCommands('%7', 'commando-paste-123')).toEqual({
      load: ['load-buffer', '-b', 'commando-paste-123', '-'],
      paste: [
        'paste-buffer',
        '-p',
        '-d',
        '-b',
        'commando-paste-123',
        '-t',
        '%7',
      ],
      cleanup: ['delete-buffer', '-b', 'commando-paste-123'],
    })
  })

  it('rejects untrusted pane and buffer identifiers', () => {
    expect(() => pasteBufferCommands('7', 'commando-paste-123')).toThrow(/pane id/)
    expect(() => pasteBufferCommands('%7', 'bad; delete-buffer')).toThrow(/buffer name/)
  })
})

describe('tmux byte input dispatch', () => {
  it('delegates exact bytes to the controller pool', async () => {
    const sendBytes = vi
      .spyOn(TmuxControllerPool.prototype, 'sendBytes')
      .mockResolvedValue(undefined)
    const client = new TmuxClient()
    const bytes = Buffer.from([0x00, 0x80, 0xff])

    await client.sendBytes('$1', '%7', bytes)

    expect(sendBytes).toHaveBeenCalledWith('$1', '%7', bytes)
    client.close()
  })
})
