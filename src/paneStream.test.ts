import { describe, expect, it, vi } from 'vitest'

import {
  decodeBase64Bytes,
  PaneStreamRegistry,
  type PaneReset,
  type PaneTerminalSink,
} from './paneStream'

const terminalState = {
  width: 120,
  height: 40,
  cursorX: 0,
  cursorY: 0,
  alternateSavedX: 0,
  alternateSavedY: 0,
  alternateOn: false,
  cursorVisible: true,
  cursorShape: 'default' as const,
  cursorBlinking: false,
  scrollRegionUpper: 0,
  scrollRegionLower: 39,
  wrapFlag: true,
  originFlag: false,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: false,
  mouseAnyFlag: false,
  mouseSgrFlag: false,
  paneTabs: [],
}

function reset(revision: number, data = new Uint8Array([revision])): PaneReset {
  return { data, cols: 120, rows: 40, terminalState, revision }
}

function sink() {
  const reset = vi.fn<PaneTerminalSink['reset']>()
  const write = vi.fn<PaneTerminalSink['write']>()
  return { reset, write }
}

describe('decodeBase64Bytes', () => {
  it('preserves raw byte values instead of decoding through a string', () => {
    expect([...decodeBase64Bytes('AP+AAQI=')]).toEqual([0, 255, 128, 1, 2])
  })
})

describe('PaneStreamRegistry', () => {
  it('applies a buffered reset before buffered live data when the pane mounts', () => {
    const registry = new PaneStreamRegistry()
    const terminal = sink()
    const resetMessage = reset(7)
    const liveData = new Uint8Array([8])

    registry.pushReset('%1', resetMessage)
    registry.pushData('%1', liveData, 8)
    registry.register('%1', terminal)

    expect(terminal.reset).toHaveBeenCalledWith(resetMessage)
    expect(terminal.write).toHaveBeenCalledWith(liveData, 8)
    expect(terminal.reset.mock.invocationCallOrder[0]).toBeLessThan(
      terminal.write.mock.invocationCallOrder[0],
    )
  })

  it('rejects stale data and stale resets', () => {
    const registry = new PaneStreamRegistry()
    const terminal = sink()
    registry.register('%1', terminal)

    expect(registry.pushReset('%1', reset(10))).toBe(true)
    expect(registry.pushData('%1', new Uint8Array([11]), 11)).toBe(true)
    expect(registry.pushData('%1', new Uint8Array([9]), 9)).toBe(false)
    expect(registry.pushReset('%1', reset(9))).toBe(false)

    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(terminal.write).toHaveBeenCalledTimes(1)
  })

  it('accepts an equal-revision reset when a remounted pane is reseeded', () => {
    const registry = new PaneStreamRegistry()
    const first = sink()
    const unregister = registry.register('%1', first)
    registry.pushReset('%1', reset(12))
    unregister()

    const reseed = reset(12, new Uint8Array([42]))
    expect(registry.pushReset('%1', reseed)).toBe(true)
    const second = sink()
    registry.register('%1', second)

    expect(second.reset).toHaveBeenCalledWith(reseed)
  })

  it('drops expired pre-mount data and waits for a fresh reset', () => {
    let now = 1_000
    const registry = new PaneStreamRegistry(() => now)
    registry.pushReset('%1', reset(1))
    registry.pushData('%1', new Uint8Array([2]), 2)
    now += 5_001

    const terminal = sink()
    registry.register('%1', terminal)
    expect(terminal.reset).not.toHaveBeenCalled()
    expect(terminal.write).not.toHaveBeenCalled()
  })

  it('clears connection-era revisions so a restarted daemon can reseed from revision one', () => {
    const registry = new PaneStreamRegistry()
    const terminal = sink()
    registry.register('%1', terminal)
    registry.pushReset('%1', reset(20))

    registry.clear()

    expect(registry.pushData('%1', new Uint8Array([1]), 1)).toBe(true)
    expect(terminal.write).toHaveBeenCalledTimes(0)
    expect(registry.pushReset('%1', reset(1))).toBe(true)
    expect(terminal.reset).toHaveBeenLastCalledWith(reset(1))
  })
})
