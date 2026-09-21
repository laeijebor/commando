import type { WebPanePendingNote } from '@commando/protocol'

import { parseTileSelectorAnchors, parseTileServerMessage, parseTileInspectResult } from './protocol'
import {
  INITIAL_TILE_STATE,
  reduceTileMessage,
  tileCloseState,
  tileRetryDelay,
  type TileRelayState,
} from './relay'

function note(overrides: Partial<WebPanePendingNote> & { id: number }): WebPanePendingNote {
  return {
    selector: '#candidate-inbox',
    tag: 'section',
    rect: { x: 0, y: 0, width: 10, height: 10 },
    comment: 'Make the needs-you row taller',
    revision: 1,
    ...overrides,
  }
}

describe('frames', () => {
  it('promotes the stream to streaming and bumps the sequence', () => {
    const first = reduceTileMessage(INITIAL_TILE_STATE, { type: 'frame', data: 'AAAA' })
    expect(first.phase).toBe('streaming')
    expect(first.frame).toBe('AAAA')
    expect(first.frameSeq).toBe(1)

    const second = reduceTileMessage(first, { type: 'frame', data: 'BBBB' })
    expect(second.frame).toBe('BBBB')
    expect(second.frameSeq).toBe(2)
  })

  it('remembers the capture size from the frame metadata', () => {
    const state = reduceTileMessage(INITIAL_TILE_STATE, {
      type: 'frame',
      data: 'AAAA',
      metadata: { deviceWidth: 390, deviceHeight: 640 },
    })
    expect(state.frameSize).toEqual({ width: 390, height: 640 })
  })

  it('keeps the last known size when a frame carries no metadata', () => {
    const sized = reduceTileMessage(INITIAL_TILE_STATE, {
      type: 'frame',
      data: 'AAAA',
      metadata: { deviceWidth: 390, deviceHeight: 640 },
    })
    expect(reduceTileMessage(sized, { type: 'frame', data: 'BBBB' }).frameSize)
      .toEqual({ width: 390, height: 640 })
  })

  it('ignores an empty frame rather than blanking the tile', () => {
    const state = reduceTileMessage(INITIAL_TILE_STATE, { type: 'frame', data: 'AAAA' })
    expect(reduceTileMessage(state, { type: 'frame', data: '' })).toBe(state)
  })
})

describe('ready and engine errors', () => {
  it('reports ready before the first frame and does not undo streaming', () => {
    const ready = reduceTileMessage(INITIAL_TILE_STATE, { type: 'ready' })
    expect(ready.phase).toBe('ready')
    const streaming = reduceTileMessage(ready, { type: 'frame', data: 'AAAA' })
    expect(reduceTileMessage(streaming, { type: 'ready' })).toBe(streaming)
  })

  it('surfaces the message chromium reported', () => {
    const state = reduceTileMessage(INITIAL_TILE_STATE, {
      type: 'engine_error',
      message: 'Chromium is not installed',
    })
    expect(state).toMatchObject({ phase: 'error', detail: 'Chromium is not installed' })
  })
})

describe('pending snapshots', () => {
  const seeded: TileRelayState = reduceTileMessage(INITIAL_TILE_STATE, {
    type: 'pending',
    revision: 4,
    notes: [note({ id: 1 }), note({ id: 2 })],
    knownUpTo: 2,
    dropped: 0,
  })

  it('replaces the queue whole and never merges', () => {
    const next = reduceTileMessage(seeded, {
      type: 'pending',
      revision: 5,
      notes: [note({ id: 3 })],
      knownUpTo: 3,
      dropped: 1,
    })
    expect(next.pending.notes.map((item) => item.id)).toEqual([3])
    expect(next.pending).toMatchObject({ revision: 5, knownUpTo: 3, dropped: 1 })
  })

  it('empties the queue when the daemon says it is empty', () => {
    const next = reduceTileMessage(seeded, { type: 'pending', notes: [], knownUpTo: 3, dropped: 0 })
    expect(next.pending.notes).toEqual([])
  })

  it('leaves the frame alone', () => {
    const streaming = reduceTileMessage(seeded, { type: 'frame', data: 'AAAA' })
    expect(reduceTileMessage(streaming, { type: 'pending', notes: [], knownUpTo: 0, dropped: 0 }).frame)
      .toBe('AAAA')
  })
})

describe('close codes', () => {
  it('treats 4404 and 4410 as a tile that is gone', () => {
    expect(tileCloseState(INITIAL_TILE_STATE, 4404).phase).toBe('gone')
    expect(tileCloseState(INITIAL_TILE_STATE, 4410)).toMatchObject({
      phase: 'gone',
      detail: 'The tile was closed on the host.',
    })
  })

  it('reports 4503 as the chromium engine being unavailable', () => {
    expect(tileCloseState(INITIAL_TILE_STATE, 4503)).toMatchObject({
      phase: 'unavailable',
      detail: 'Chromium engine unavailable',
    })
  })

  it('keeps the reason the engine reported before the close', () => {
    const errored = reduceTileMessage(INITIAL_TILE_STATE, {
      type: 'engine_error',
      message: 'Chromium is not installed',
    })
    expect(tileCloseState(errored, 4503).detail).toBe('Chromium is not installed')
  })

  it('treats anything else as a retryable close', () => {
    expect(tileCloseState(INITIAL_TILE_STATE, 1006, 'socket hang up')).toMatchObject({
      phase: 'closed',
      detail: 'socket hang up',
    })
  })
})

describe('reconnect backoff', () => {
  it('doubles from 700ms and caps at 10s', () => {
    expect(tileRetryDelay(1)).toBe(700)
    expect(tileRetryDelay(2)).toBe(1_400)
    expect(tileRetryDelay(5)).toBe(10_000)
    expect(tileRetryDelay(30)).toBe(10_000)
  })
})

describe('message parsing', () => {
  it('ignores anything that is not a typed JSON object', () => {
    expect(parseTileServerMessage('not json')).toBeNull()
    expect(parseTileServerMessage('[1,2]')).toBeNull()
    expect(parseTileServerMessage('{"nope":1}')).toBeNull()
    expect(parseTileServerMessage(new ArrayBuffer(4))).toBeNull()
  })

  it('re-validates what the page returned for an inspect', () => {
    expect(parseTileInspectResult({
      ok: true,
      selector: '#a',
      tag: 'div',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 'Hello',
    })).toEqual({
      ok: true,
      selector: '#a',
      tag: 'div',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      text: 'Hello',
    })
    expect(parseTileInspectResult({ ok: false, error: 'No element at this point' }))
      .toEqual({ ok: false, error: 'No element at this point' })
    expect(parseTileInspectResult({ ok: true, selector: '#a', tag: 'div' }).ok).toBe(false)
  })

  it('drops malformed and duplicated selector anchors', () => {
    expect(parseTileSelectorAnchors([
      { noteId: 1, rect: { x: 0, y: 0, width: 10, height: 10 } },
      { noteId: 1, rect: { x: 5, y: 5, width: 10, height: 10 } },
      { noteId: 2, rect: { x: 0, y: 0, width: 0, height: 10 } },
      { noteId: 3, rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])).toEqual([
      { noteId: 1, rect: { x: 0, y: 0, width: 10, height: 10 } },
      { noteId: 3, rect: { x: 1, y: 2, width: 3, height: 4 } },
    ])
    expect(parseTileSelectorAnchors('nope')).toEqual([])
  })
})
