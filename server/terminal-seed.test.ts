import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'

import type { PaneTerminalState } from '../shared/protocol.js'
import { buildPaneSeed } from './terminal-seed.js'

const state: PaneTerminalState = {
  width: 80,
  height: 24,
  cursorX: 12,
  cursorY: 10,
  alternateSavedX: 4,
  alternateSavedY: 5,
  alternateOn: true,
  cursorVisible: true,
  cursorShape: 'block',
  cursorBlinking: true,
  scrollRegionUpper: 2,
  scrollRegionLower: 20,
  wrapFlag: true,
  originFlag: true,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: true,
  mouseAnyFlag: true,
  mouseSgrFlag: true,
  paneTabs: [8, 16],
}

describe('pane terminal bootstrap', () => {
  it('hydrates the active grid before restoring terminal modes and cursor state', () => {
    const output = buildPaneSeed(
      Buffer.from('table\r\nrow'),
      state,
      Buffer.from('shell prompt'),
    ).toString('utf8')

    expect(output.indexOf('shell prompt')).toBeLessThan(output.indexOf('\u001b[?1049h'))
    expect(output.indexOf('\u001b[?1049h')).toBeLessThan(output.indexOf('table'))
    expect(output).toContain('\u001b[3g\u001b[9G\u001bH\u001b[17G\u001bH')
    expect(output).toContain('\u001b[3;21r')
    expect(output).toContain('\u001b[?7h')
    expect(output).toContain('\u001b[?1h')
    expect(output).toContain('\u001b[?1003h\u001b[?1006h')
    expect(output).toContain('\u001b[1 q')
    expect(output).toContain('\u001b[?6h\u001b[9;13H\u001b[?25h')
    expect(output.endsWith('\u001b[?2026l')).toBe(true)
  })

  it('hydrates an alternate-screen table into exact source columns', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const table = [
      '+----------------------------------------------+-----------------------------+',
      '| Lever                                        | Expected impact             |',
      '+----------------------------------------------+-----------------------------+',
    ].join('\r\n')

    await new Promise<void>((resolve) => {
      terminal.write(buildPaneSeed(Buffer.from(table), state, Buffer.from('shell')), resolve)
    })

    expect(terminal.buffer.active.type).toBe('alternate')
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      '+----------------------------------------------+-----------------------------+',
    )
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(
      '| Lever                                        | Expected impact             |',
    )
    expect(terminal.buffer.active.cursorX).toBe(state.cursorX)
    expect(terminal.buffer.active.cursorY).toBe(state.cursorY)

    await new Promise<void>((resolve) => terminal.write('\u001b[?1049l', resolve))
    expect(terminal.buffer.active.type).toBe('normal')
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('shell')
    expect(terminal.buffer.active.cursorX).toBe(state.alternateSavedX)
    expect(terminal.buffer.active.cursorY).toBe(state.alternateSavedY)
    terminal.dispose()
  })

  it('keeps a normal-screen shell in the normal buffer with a steady bar cursor', () => {
    const output = buildPaneSeed(
      Buffer.from('prompt'),
      {
        ...state,
        alternateOn: false,
        cursorShape: 'bar',
        cursorBlinking: false,
        originFlag: false,
        mouseAnyFlag: false,
        mouseSgrFlag: false,
      },
    ).toString('utf8')

    expect(output).not.toContain('\u001b[?1049h')
    expect(output).toContain('\u001b[6 q')
    expect(output).toContain('\u001b[11;13H')
  })
})
