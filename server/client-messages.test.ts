import { describe, expect, it } from 'vitest'
import { MAX_PASTE_BYTES, type SpecialKey } from '../shared/protocol.js'
import { MAX_INPUT_BYTES, parseClientMessage } from './client-messages.js'

describe('client message validation', () => {
  it('accepts only the fixed special-key set', () => {
    const keys: SpecialKey[] = [
      'Enter',
      'Backspace',
      'Tab',
      'Escape',
      'Up',
      'Down',
      'Left',
      'Right',
      'Home',
      'End',
      'Insert',
      'Delete',
      'PageUp',
      'PageDown',
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
      'F7',
      'F8',
      'F9',
      'F10',
      'F11',
      'F12',
      'C-c',
      'C-d',
      'C-z',
      'C-l',
    ]
    for (const key of keys) {
      expect(
        parseClientMessage({
          type: 'key',
          paneId: '%1',
          key,
          requestId: `key-${key}`,
        }).ok,
      ).toBe(true)
    }
    expect(
      parseClientMessage({
        type: 'key',
        paneId: '%1',
        key: 'run-shell',
        requestId: 'key-2',
      }).ok,
    ).toBe(false)
  })

  it('accepts one bounded paste message and rejects empty, null, and oversized data', () => {
    const data = 'é'.repeat(MAX_PASTE_BYTES / 2)
    expect(
      parseClientMessage({
        type: 'paste',
        paneId: '%1',
        data,
        requestId: 'paste-1',
      }),
    ).toMatchObject({ ok: true, message: { type: 'paste', data } })

    for (const invalidData of ['', 'bad\0paste', `${data}x`]) {
      expect(
        parseClientMessage({
          type: 'paste',
          paneId: '%1',
          data: invalidData,
          requestId: 'paste-invalid',
        }).ok,
      ).toBe(false)
    }
  })

  it('rejects unstable pane ids, null bytes, and oversized literal input', () => {
    expect(
      parseClientMessage({
        type: 'input',
        paneId: '1',
        data: 'hello',
        requestId: 'input-1',
      }).ok,
    ).toBe(false)
    expect(
      parseClientMessage({
        type: 'input',
        paneId: '%1',
        data: 'hello\0world',
        requestId: 'input-2',
      }).ok,
    ).toBe(false)
    expect(
      parseClientMessage({
        type: 'input',
        paneId: '%1',
        data: 'x'.repeat(MAX_INPUT_BYTES + 1),
        requestId: 'input-3',
      }).ok,
    ).toBe(false)
  })

  it('correlates workspace loads with a validated request id', () => {
    expect(
      parseClientMessage({
        type: 'load_workspace',
        sessionId: '$1',
        requestId: 'load-1',
      }),
    ).toMatchObject({
      ok: true,
      message: { sessionId: '$1', requestId: 'load-1' },
    })
    expect(
      parseClientMessage({ type: 'load_workspace', sessionId: '$1' }).ok,
    ).toBe(false)
  })
})
