import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_ROWS,
  TERMINAL_SCROLLBACK_LINES,
  type ServerMessage,
} from '@commando/protocol'

import {
  encodeCommand,
  fitDimensions,
  parseTerminalEvent,
  resetCommand,
  terminalDimensionsForViewport,
  TerminalCommandQueue,
  writeCommand,
  type TerminalCommand,
} from './bridge'
import { TERMINAL_HTML } from './terminal-html'

const terminalState = {
  width: 80,
  height: 24,
  cursorX: 0,
  cursorY: 0,
  alternateSavedX: 0,
  alternateSavedY: 0,
  alternateOn: false,
  cursorVisible: true,
  cursorShape: 'block' as const,
  cursorBlinking: true,
  scrollRegionUpper: 0,
  scrollRegionLower: 23,
  wrapFlag: true,
  originFlag: false,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: false,
  mouseAnyFlag: false,
  mouseSgrFlag: false,
  paneTabs: [],
}

function reset(overrides: Partial<Extract<ServerMessage, { type: 'pane_reset' }>> = {}) {
  return {
    type: 'pane_reset' as const,
    paneId: '%1',
    data: 'aGVsbG8=',
    encoding: 'base64' as const,
    cols: 120,
    rows: 40,
    terminalState,
    revision: 7,
    ...overrides,
  }
}

describe('pane_reset and pane_data commands', () => {
  it('passes base64 through untouched and keeps the pane grid', () => {
    expect(resetCommand(reset())).toEqual({
      type: 'reset',
      data: 'aGVsbG8=',
      cols: 120,
      rows: 40,
      cursorShape: 'block',
      cursorBlink: true,
      revision: 7,
    })
  })

  it('clamps a nonsense grid rather than resizing xterm to zero', () => {
    const command = resetCommand(reset({ cols: 0, rows: Number.NaN }))
    expect(command).toMatchObject({ cols: 2, rows: MIN_TERMINAL_ROWS })
  })

  it('forwards pane_data as base64 with its revision', () => {
    expect(writeCommand({
      type: 'pane_data',
      paneId: '%1',
      data: 'd29ybGQ=',
      encoding: 'base64',
      revision: 9,
    })).toEqual({ type: 'write', data: 'd29ybGQ=', revision: 9 })
  })
})

describe('encodeCommand', () => {
  it('injects a call the page can parse, ending in true', () => {
    const script = encodeCommand({ type: 'measure' })
    expect(script).toBe(
      'window.__commandoTerminal && window.__commandoTerminal.receive({"type":"measure"}); true;',
    )
  })

  it('escapes the line terminators JSON leaves bare', () => {
    const script = encodeCommand({ type: 'write', data: 'a\u2028b\u2029c', revision: 1 })
    expect(script).not.toMatch(/[\u2028\u2029]/u)
    expect(script).toContain('\\u2028')
    expect(script).toContain('\\u2029')
  })

  it('round-trips a reset through JSON', () => {
    const command = resetCommand(reset())
    const payload = encodeCommand(command).match(/receive\((.*)\); true;$/u)?.[1]
    expect(JSON.parse(payload ?? '')).toEqual(command)
  })
})

describe('parseTerminalEvent', () => {
  it('accepts the events the page posts', () => {
    expect(parseTerminalEvent('{"type":"ready"}')).toEqual({ type: 'ready' })
    expect(parseTerminalEvent('{"type":"scroll","atBottom":false}')).toEqual({
      type: 'scroll',
      atBottom: false,
    })
  })

  it('rejects anything that is not a known event', () => {
    expect(parseTerminalEvent('not json')).toBeNull()
    expect(parseTerminalEvent('{"type":"whatever"}')).toBeNull()
    expect(parseTerminalEvent('[1,2,3]')).toBeNull()
    expect(parseTerminalEvent(42)).toBeNull()
  })
})

describe('TerminalCommandQueue', () => {
  const write = (data: string, revision: number): TerminalCommand => ({
    type: 'write',
    data,
    revision,
  })

  it('holds commands until the page is ready, then drains in order', () => {
    const queue = new TerminalCommandQueue()
    expect(queue.push(resetCommand(reset()))).toEqual([])
    expect(queue.push(write('aa', 8))).toEqual([])
    expect(queue.size).toBe(2)

    const drained = queue.markReady()
    expect(drained.map((command) => command.type)).toEqual(['reset', 'write'])
    expect(queue.size).toBe(0)
  })

  it('sends straight through once ready', () => {
    const queue = new TerminalCommandQueue()
    queue.markReady()
    const command = write('bb', 1)
    expect(queue.push(command)).toEqual([command])
  })

  it('drops everything a later reset supersedes', () => {
    const queue = new TerminalCommandQueue()
    queue.push(write('old', 1))
    const second = resetCommand(reset({ revision: 12 }))
    queue.push(second)
    expect(queue.markReady()).toEqual([second])
  })

  it('asks for a reseed instead of buffering an unbounded backlog', () => {
    const queue = new TerminalCommandQueue()
    const huge = 'x'.repeat(1_000_000)
    for (let index = 0; index < 6; index += 1) queue.push(write(huge, index))
    expect(queue.needsReseed).toBe(true)
    expect(queue.markReady()).toEqual([])
    queue.clearReseed()
    expect(queue.needsReseed).toBe(false)
  })

  it('queues again when the WebView reloads', () => {
    const queue = new TerminalCommandQueue()
    queue.markReady()
    queue.markLoading()
    expect(queue.isReady).toBe(false)
    expect(queue.push(write('cc', 2))).toEqual([])
  })

  it('keeps a seed that arrived before the page started loading', () => {
    // The real iOS order: the socket is already open, so `pane_reset` lands
    // before the WebView reports `onLoadStart`. The seed is only sent once per
    // subscription, so losing it here leaves the pane blank for good.
    const queue = new TerminalCommandQueue()
    const seed = resetCommand(reset({ revision: 3 }))
    queue.push(seed)
    queue.push(write('after', 4))

    queue.markLoading()

    expect(queue.needsReseed).toBe(false)
    expect(queue.markReady().map((command) => command.type)).toEqual(['reset', 'write'])
  })

  it('asks for a reseed when a reload leaves nothing queued to rebuild from', () => {
    const queue = new TerminalCommandQueue()
    queue.markReady()
    queue.push(resetCommand(reset()))

    // That reset went into a document the reload has just thrown away.
    queue.markLoading()

    expect(queue.needsReseed).toBe(true)
    expect(queue.markReady()).toEqual([])
  })
})

describe('terminalDimensionsForViewport', () => {
  it('computes cols and rows from the measured cell size', () => {
    expect(terminalDimensionsForViewport(390, 500, 6.6, 14)).toEqual({ cols: 59, rows: 35 })
  })

  it('clamps to the protocol bounds', () => {
    expect(terminalDimensionsForViewport(100_000, 100_000, 1, 1)).toEqual({
      cols: MAX_TERMINAL_COLS,
      rows: MAX_TERMINAL_ROWS,
    })
    expect(terminalDimensionsForViewport(1, 1, 10, 10)).toEqual({ cols: 2, rows: 1 })
  })

  it('refuses a measurement that has not settled', () => {
    expect(terminalDimensionsForViewport(0, 500, 6.6, 14)).toBeNull()
    expect(terminalDimensionsForViewport(390, 500, 0, 14)).toBeNull()
    expect(terminalDimensionsForViewport(390, Number.NaN, 6.6, 14)).toBeNull()
  })

  it('fits from the metrics the page reported, or nothing at all', () => {
    expect(fitDimensions(null)).toBeNull()
    expect(fitDimensions({
      cellWidth: 6.6,
      cellHeight: 14,
      viewportWidth: 390,
      viewportHeight: 500,
    })).toEqual({ cols: 59, rows: 35 })
  })
})

describe('the generated page', () => {
  it('carries xterm.js, its stylesheet and the page script inline', () => {
    expect(TERMINAL_HTML).toContain('<div id="terminal"></div>')
    expect(TERMINAL_HTML).toContain('.xterm-viewport')
    expect(TERMINAL_HTML).toContain('window.__commandoTerminal')
    expect(TERMINAL_HTML).not.toMatch(/<script[^>]+src=/u)
    expect(TERMINAL_HTML).not.toMatch(/<link[^>]+href=/u)
  })

  it('keeps the terminal options the desktop uses', () => {
    expect(TERMINAL_HTML).toContain(`var SCROLLBACK = ${TERMINAL_SCROLLBACK_LINES}`)
    expect(TERMINAL_HTML).toContain('scrollback: SCROLLBACK')
    expect(TERMINAL_HTML).toContain('allowProposedApi: true')
    expect(TERMINAL_HTML).toContain("cursorInactiveStyle: 'outline'")
    // Rosé Pine Moon, the same palette as TERMINAL_THEME in src/XtermPane.tsx.
    expect(TERMINAL_HTML).toContain("background: '#232136'")
    expect(TERMINAL_HTML).toContain("foreground: '#e0def4'")
  })
})
