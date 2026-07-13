import { describe, expect, it } from 'vitest'
import {
  MAX_PASTE_BYTES,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type SpecialKey,
} from '../shared/protocol.js'
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

  it('accepts bounded pane resize leases and correlated releases', () => {
    expect(parseClientMessage({
      type: 'resize_pane',
      paneId: '%7',
      cols: 120,
      rows: 40,
      requestId: 'resize-1',
    })).toMatchObject({
      ok: true,
      message: { paneId: '%7', cols: 120, rows: 40 },
    })
    expect(parseClientMessage({
      type: 'release_resize',
      paneId: '%7',
      requestId: 'resize-release-1',
    })).toMatchObject({ ok: true, message: { paneId: '%7' } })

    for (const [cols, rows] of [
      [MIN_TERMINAL_COLS - 1, 40],
      [MAX_TERMINAL_COLS + 1, 40],
      [120, MIN_TERMINAL_ROWS - 1],
      [120, MAX_TERMINAL_ROWS + 1],
      [120.5, 40],
    ]) {
      expect(parseClientMessage({
        type: 'resize_pane',
        paneId: '%7',
        cols,
        rows,
        requestId: 'resize-invalid',
      }).ok).toBe(false)
    }
  })

  it('validates window layout specs', () => {
    const spec = {
      kind: 'split',
      direction: 'row',
      children: [
        { kind: 'pane', paneId: '%3', cols: 80, rows: 24 },
        {
          kind: 'split',
          direction: 'column',
          children: [
            { kind: 'pane', paneId: '%4', cols: 80, rows: 12 },
            { kind: 'pane', paneId: '%5', cols: 80, rows: 11 },
          ],
        },
      ],
    }
    for (const type of ['apply_window_layout', 'set_window_layout'] as const) {
      expect(parseClientMessage({
        type,
        windowId: '@2',
        spec,
        requestId: 'layout-1',
      })).toMatchObject({
        ok: true,
        message: { type, windowId: '@2', spec },
      })
    }

    const invalidSpecs: unknown[] = [
      { kind: 'pane', paneId: 'nope', cols: 80, rows: 24 },
      { kind: 'pane', paneId: '%1', cols: 0, rows: 24 },
      { kind: 'split', direction: 'row', children: [] },
      {
        kind: 'split',
        direction: 'row',
        children: [{ kind: 'pane', paneId: '%1', cols: 80, rows: 24 }],
      },
      {
        kind: 'split',
        direction: 'diagonal',
        children: [
          { kind: 'pane', paneId: '%1', cols: 80, rows: 24 },
          { kind: 'pane', paneId: '%2', cols: 80, rows: 24 },
        ],
      },
      {
        kind: 'split',
        direction: 'row',
        children: [
          { kind: 'pane', paneId: '%1', cols: 80, rows: 24 },
          { kind: 'pane', paneId: '%1', cols: 80, rows: 24 },
        ],
      },
    ]
    for (const invalid of invalidSpecs) {
      expect(parseClientMessage({
        type: 'apply_window_layout',
        windowId: '@2',
        spec: invalid,
        requestId: 'layout-invalid',
      }).ok).toBe(false)
    }
    expect(parseClientMessage({
      type: 'release_all_resizes',
      requestId: 'layout-release-1',
    }).ok).toBe(true)
  })
})
