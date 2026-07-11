import { describe, expect, it } from 'vitest'
import { pasteBufferCommands } from './tmux.js'

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
