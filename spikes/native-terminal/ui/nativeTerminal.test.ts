import { describe, expect, it, vi } from 'vitest'

import type { PaneTerminalState } from '../../../shared/protocol'
import {
  boundedTerminalSize,
  chunkTerminalInput,
  createNativeTerminalSink,
  decodeNativeInput,
  encodeBase64Bytes,
  parseNativeTerminalEvent,
  resolveSpikeToken,
  selectLivePane,
  type NativeTerminalMessage,
} from './nativeTerminal'

const terminalState: PaneTerminalState = {
  width: 80,
  height: 24,
  cursorX: 3,
  cursorY: 4,
  alternateSavedX: 0,
  alternateSavedY: 0,
  alternateOn: false,
  cursorVisible: true,
  cursorShape: 'block',
  cursorBlinking: true,
  scrollRegionUpper: 0,
  scrollRegionLower: 23,
  wrapFlag: false,
  originFlag: false,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: false,
  mouseAnyFlag: false,
  mouseSgrFlag: false,
  paneTabs: [8, 16],
}

describe('selectLivePane', () => {
  const panes = [
    { id: '%1', active: false, dead: false },
    { id: '%2', active: true, dead: false },
    { id: '%3', active: false, dead: true },
  ]

  it('preserves the selected pane while it remains live in the snapshot', () => {
    expect(selectLivePane(panes, '%1')?.id).toBe('%1')
    expect(selectLivePane(panes, '%3')?.id).toBe('%2')
  })

  it('falls back to the active live pane and then the first live pane', () => {
    expect(selectLivePane(panes, '%9')?.id).toBe('%2')
    expect(selectLivePane(panes.map((pane) => ({ ...pane, active: false })), null)?.id).toBe('%1')
    expect(selectLivePane(panes.map((pane) => ({ ...pane, dead: true })), null)).toBeNull()
  })
})

describe('resolveSpikeToken', () => {
  it('prefers an encoded fragment token and scrubs it while preserving the shell query', () => {
    expect(resolveSpikeToken({
      pathname: '/',
      search: '?shell=swift',
      hash: '#token=native%20spike',
    }, 'stored-token')).toEqual({
      token: 'native spike',
      shouldScrub: true,
      scrubbedUrl: '/?shell=swift',
    })
  })

  it('supports and scrubs the temporary query-token contract', () => {
    expect(resolveSpikeToken({
      pathname: '/terminal',
      search: '?shell=swift&token=query-token&mode=debug',
      hash: '',
    }, '')).toEqual({
      token: 'query-token',
      shouldScrub: true,
      scrubbedUrl: '/terminal?shell=swift&mode=debug',
    })
  })

  it('supports a raw fragment and falls back to storage after the URL is clean', () => {
    expect(resolveSpikeToken({
      pathname: '/',
      search: '?shell=swift',
      hash: '#raw%20token',
    }, '')).toEqual({
      token: 'raw token',
      shouldScrub: true,
      scrubbedUrl: '/?shell=swift',
    })
    expect(resolveSpikeToken({
      pathname: '/',
      search: '?shell=swift',
      hash: '',
    }, 'stored-token')).toEqual({
      token: 'stored-token',
      shouldScrub: false,
      scrubbedUrl: '/?shell=swift',
    })
  })

  it('lets the fragment override a temporary query token and scrubs both', () => {
    expect(resolveSpikeToken({
      pathname: '/',
      search: '?shell=swift&token=query-token',
      hash: '#token=fragment-token',
    }, '')).toEqual({
      token: 'fragment-token',
      shouldScrub: true,
      scrubbedUrl: '/?shell=swift',
    })
  })
})

describe('native terminal byte conversion', () => {
  it('round-trips arbitrary terminal bytes through base64', () => {
    const bytes = new Uint8Array([0, 27, 31, 128, 255])
    const encoded = encodeBase64Bytes(bytes)
    expect([...Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))]).toEqual([...bytes])
  })

  it('decodes UTF-8 input while preserving escape and control bytes', () => {
    const bytes = new TextEncoder().encode(`\u001b[Dé\u0003`)
    expect(decodeNativeInput(encodeBase64Bytes(bytes))).toBe(`\u001b[Dé\u0003`)
  })

  it('rejects malformed base64, invalid UTF-8, empty input, and null bytes', () => {
    expect(decodeNativeInput('not base64')).toBeNull()
    expect(decodeNativeInput('/w==')).toBeNull()
    expect(decodeNativeInput('Af==')).toBeNull()
    expect(decodeNativeInput('')).toBeNull()
    expect(decodeNativeInput('AA==')).toBeNull()
  })

  it('chunks by Unicode code point like production terminal input', () => {
    const chunks = chunkTerminalInput(`${'a'.repeat(1_023)}😀b`)
    expect(chunks).toEqual([`${'a'.repeat(1_023)}😀`, 'b'])
  })
})

describe('native terminal events', () => {
  it('accepts valid input and resize events and bounds resize dimensions', () => {
    expect(parseNativeTerminalEvent({ kind: 'input', data: 'Gw==' })).toEqual({
      kind: 'input',
      data: 'Gw==',
    })
    const resize = parseNativeTerminalEvent({ kind: 'resize', cols: 1_000, rows: 500 })
    expect(resize?.kind).toBe('resize')
    if (resize?.kind === 'resize') {
      expect(boundedTerminalSize(resize)).toEqual({ cols: 500, rows: 200 })
    }
  })

  it.each([
    null,
    [],
    { kind: 'input', data: 27 },
    { kind: 'resize', cols: 0, rows: 24 },
    { kind: 'resize', cols: 80.5, rows: 24 },
    { kind: 'unknown' },
  ])('ignores malformed event %j', (event) => {
    expect(parseNativeTerminalEvent(event)).toBeNull()
  })
})

describe('createNativeTerminalSink', () => {
  it('posts complete reset and ordered data payloads for the selected pane', () => {
    const messages: NativeTerminalMessage[] = []
    const postMessage = vi.fn((message: NativeTerminalMessage) => messages.push(message))
    const sink = createNativeTerminalSink('%7', postMessage)

    sink.reset({
      data: new Uint8Array([27, 91, 50, 74]),
      cols: 120,
      rows: 40,
      terminalState,
      revision: 12,
    })
    sink.write(new Uint8Array([255, 0, 128]), 13)

    expect(messages).toEqual([
      {
        kind: 'reset',
        paneId: '%7',
        data: 'G1sySg==',
        cols: 120,
        rows: 40,
        terminalState,
        revision: 12,
      },
      {
        kind: 'data',
        paneId: '%7',
        data: '/wCA',
        revision: 13,
      },
    ])
  })
})
