// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_PASTE_BYTES, type PaneTerminalState, type SpecialKey } from '../shared/protocol'
import cutFixtures from '../shared/fixtures/terminal-input-cut.json'
import { dispatchBoundedPaste, extractTerminalInput, macTerminalAction, modifiedControlShiftS, semanticKeyForEvent } from './terminalInput'
import { XtermPane } from './XtermPane'

const xterm = vi.hoisted(() => ({
  handleKey: null as ((event: KeyboardEvent) => boolean) | null,
  handleData: null as ((data: string) => void) | null,
  handleWheel: null as ((event: WheelEvent) => boolean) | null,
  selection: '',
  active: {
    viewportY: 2, baseY: 3, cursorY: 0, cursorX: 10,
    getLine: vi.fn(),
  },
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 3
    options = {}
    buffer = { active: xterm.active }
    open() {}
    loadAddon() {}
    dispose() {}
    onData(handler: (data: string) => void) { xterm.handleData = handler; return { dispose() {} } }
    onSelectionChange() { return { dispose() {} } }
    attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) { xterm.handleWheel = handler }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { xterm.handleKey = handler }
    hasSelection() { return xterm.selection.length > 0 }
    getSelection() { return xterm.selection }
  },
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() { return { dispose() {} } }
  },
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  }
}

describe('terminal semantic key mapping', () => {
  it('maps navigation, editing, and function keys to protocol names', () => {
    const mappings: Array<[string, SpecialKey]> = [
      ['Enter', 'Enter'],
      ['Backspace', 'Backspace'],
      ['Tab', 'Tab'],
      ['Escape', 'Escape'],
      ['ArrowUp', 'Up'],
      ['ArrowDown', 'Down'],
      ['ArrowLeft', 'Left'],
      ['ArrowRight', 'Right'],
      ['Home', 'Home'],
      ['End', 'End'],
      ['Insert', 'Insert'],
      ['Delete', 'Delete'],
      ['PageUp', 'PageUp'],
      ['PageDown', 'PageDown'],
      ...Array.from({ length: 12 }, (_, index) => [
        `F${index + 1}`,
        `F${index + 1}` as SpecialKey,
      ] as [string, SpecialKey]),
    ]

    for (const [key, expected] of mappings) {
      expect(semanticKeyForEvent(keyEvent(key))).toBe(expected)
    }
  })

  it('forwards supported control keys semantically without consuming other controls', () => {
    expect(semanticKeyForEvent(keyEvent('c', { ctrlKey: true }))).toBe('C-c')
    expect(semanticKeyForEvent(keyEvent('D', { ctrlKey: true }))).toBe('C-d')
    expect(semanticKeyForEvent(keyEvent('k', { ctrlKey: true }))).toBeNull()
    expect(semanticKeyForEvent(keyEvent('ArrowUp', { altKey: true }))).toBeNull()
    expect(semanticKeyForEvent(keyEvent('Tab', { shiftKey: true }))).toBeNull()
  })
})

describe('modified terminal input', () => {
  it('preserves Ctrl+Shift+S without changing Ctrl+S or unrelated chords', () => {
    expect(modifiedControlShiftS(keyEvent('S', { ctrlKey: true, shiftKey: true }))).toBe('\x1b[115;6u')
    expect(modifiedControlShiftS(keyEvent('s', { ctrlKey: true, shiftKey: true }))).toBe('\x1b[115;6u')
    expect(modifiedControlShiftS(keyEvent('s', { ctrlKey: true }))).toBeNull()
    expect(modifiedControlShiftS(keyEvent('s', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
    expect(modifiedControlShiftS(keyEvent('a', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('macOS terminal editing shortcuts', () => {
  it.each([
    ['ArrowLeft', { input: '\x01' }],
    ['ArrowRight', { input: '\x05' }],
    ['Backspace', { input: '\x15' }],
    ['Delete', { input: '\x0b' }],
    ['z', { input: '\x1f' }],
    ['Z', { input: '\x1f' }],
    ['a', 'selectAll'],
    ['x', 'cut'],
  ])('maps Command+%s', (key, action) => {
    expect(macTerminalAction(keyEvent(key as string, { metaKey: true }), true)).toEqual(action)
  })

  it('never sends suspend for undo', () => {
    expect(macTerminalAction(keyEvent('z', { metaKey: true }), true)).toEqual({ input: '\x1f' })
    expect(macTerminalAction(keyEvent('z', { metaKey: true }), true)).not.toEqual({ input: '\x1a' })
  })

  it('ignores other modifiers, unrelated keys, and non-Mac platforms', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'z', 'a', 'x']) {
      expect(macTerminalAction(keyEvent(key, { metaKey: true }), false)).toBeNull()
      expect(macTerminalAction(keyEvent(key), true)).toBeNull()
      for (const modifier of ['altKey', 'ctrlKey', 'shiftKey']) {
        expect(macTerminalAction(keyEvent(key, { metaKey: true, [modifier]: true }), true)).toBeNull()
      }
    }
    for (const key of ['c', 'v', 'k', '1', '9', 'f', 'g', 'PageUp', 'PageDown']) {
      expect(macTerminalAction(keyEvent(key, { metaKey: true }), true)).toBeNull()
    }
  })
})

describe('terminal input extraction shared fixtures', () => {
  it.each(cutFixtures)('$name', ({ expected, ...screen }) => {
    expect(extractTerminalInput(screen)).toEqual(expected)
  })
})

describe('browser terminal macOS key routing', () => {
  function mount(connected = true) {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const writeText = vi.fn(() => new Promise<void>(() => {}))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const onInput = vi.fn()
    xterm.selection = ''
    const terminalState: PaneTerminalState = {
      width: 80, height: 3, cursorX: 0, cursorY: 0,
      alternateSavedX: 0, alternateSavedY: 0, alternateOn: false,
      cursorVisible: true, cursorShape: 'default', cursorBlinking: false,
      scrollRegionUpper: 0, scrollRegionLower: 2, wrapFlag: true,
      originFlag: false, insertFlag: false, keypadFlag: false,
      keypadCursorFlag: false, mouseAnyFlag: false, mouseSgrFlag: false, paneTabs: [],
    }
    const props = {
      paneId: '%1', cols: 80, rows: 3, terminalState, connected, resizeOwner: false,
      measurementKey: '', ariaLabel: 'Terminal', onInput,
      onFocus: vi.fn(), onKey: vi.fn(), onPaste: vi.fn(), onSelectionCopied: vi.fn(),
      onResize: vi.fn(), registerSink: () => () => {}, registerFocusable: vi.fn(),
    }
    const view = render(createElement(XtermPane, props))
    return {
      onInput, writeText, onKey: props.onKey, onPaste: props.onPaste,
      host: view.container.querySelector('.xterm-host')!,
      terminalState,
      disconnect: () => view.rerender(createElement(XtermPane, { ...props, connected: false })),
    }
  }

  function press(key: string, type = 'keydown') {
    const event = new KeyboardEvent(type, { key, metaKey: true, cancelable: true })
    return { event, result: xterm.handleKey!(event) }
  }

  function mockBoxInput() {
    xterm.active.getLine.mockImplementation((row: number) => ({
      getCell: (col: number) => ({
        getWidth: () => 1, isDim: () => false,
        getChars: () => (row === 3 ? '!\u00a0input' : '─'.repeat(80))[col] ?? '',
      }),
    }))
  }

  it('clears a bash box only after the clipboard write succeeds', async () => {
    const { onInput, writeText } = mount()
    let finishCopy!: () => void
    const pendingCopy = new Promise<void>((resolve) => { finishCopy = resolve })
    writeText.mockReturnValue(pendingCopy)
    mockBoxInput()
    press('x')
    expect(writeText).toHaveBeenCalledWith('!input')
    expect(onInput).not.toHaveBeenCalled()
    finishCopy()
    await pendingCopy
    await Promise.resolve()
    expect(onInput).toHaveBeenCalledWith('\x0b'.repeat(3) + '\x15'.repeat(3))
    expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(onInput.mock.invocationCallOrder[0])
  })

  it('sends raw editing input, consumes defaults, and leaves select all to xterm', () => {
    const { onInput } = mount()
    for (const [key, input] of [['ArrowLeft', '\x01'], ['ArrowRight', '\x05'], ['Backspace', '\x15'], ['Delete', '\x0b'], ['z', '\x1f']]) {
      const { event, result } = press(key)
      expect(result).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      expect(onInput).toHaveBeenLastCalledWith(input)
    }
    expect(press('a').result).toBe(true)
    expect(press('z', 'keyup').result).toBe(true)
    expect(onInput).toHaveBeenCalledTimes(5)
  })

  it('copies line input synchronously without clearing, skipping dim and wide spacer cells', async () => {
    const { onInput, writeText } = mount()
    let finishCopy!: () => void
    const pendingCopy = new Promise<void>((resolve) => { finishCopy = resolve })
    writeText.mockReturnValue(pendingCopy)
    xterm.active.getLine.mockImplementation((row: number) => ({
      getCell: (col: number) => ({
        getWidth: () => row === 3 && col === 3 ? 0 : 1,
        isDim: () => row === 3 && col >= 4 && col < 12,
        getChars: () => (row === 3 ? ['$',' ','界','','g','h','o','s','t'] : [...'history'])[col] ?? '',
      }),
    }))
    expect(press('x').result).toBe(false)
    expect(writeText).toHaveBeenCalledWith('界')
    expect(onInput).not.toHaveBeenCalled()
    finishCopy()
    await pendingCopy
    await Promise.resolve()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('copies without clearing when input arrived before Command+X', async () => {
    const { onInput, writeText } = mount()
    let finishCopy!: () => void
    const pendingCopy = new Promise<void>((resolve) => { finishCopy = resolve })
    writeText.mockReturnValue(pendingCopy)
    xterm.active.getLine.mockReturnValue({
      getCell: (col: number) => ({ getWidth: () => 1, isDim: () => false, getChars: () => '$ input'[col] ?? '' }),
    })
    xterm.handleData!('abc')
    expect(onInput).toHaveBeenCalledWith('abc')
    press('x')
    finishCopy()
    await pendingCopy
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledWith('input')
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onInput).toHaveBeenLastCalledWith('abc')
  })

  it('preserves input when the clipboard write fails', async () => {
    const { onInput, writeText } = mount()
    const failedCopy = Promise.reject(new DOMException('Denied', 'NotAllowedError'))
    writeText.mockReturnValue(failedCopy)
    mockBoxInput()
    press('x')
    expect(writeText).toHaveBeenCalledWith('!input')
    await failedCopy.catch(() => {})
    await Promise.resolve()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('does not clear if the pane disconnects while the clipboard write is pending', async () => {
    const { onInput, writeText, disconnect } = mount()
    let finishCopy!: () => void
    const pendingCopy = new Promise<void>((resolve) => { finishCopy = resolve })
    writeText.mockReturnValue(pendingCopy)
    mockBoxInput()
    press('x')
    expect(writeText).toHaveBeenCalledWith('!input')
    disconnect()
    finishCopy()
    await pendingCopy
    await Promise.resolve()
    expect(onInput).not.toHaveBeenCalled()
  })

  it.each(['data', 'semantic key', 'modified key', 'mac action', 'paste', 'mouse key'])(
    'does not clear after intervening %s while the clipboard write is pending', async (source) => {
      const { onInput, writeText, onKey, onPaste, host, terminalState } = mount()
      let finishCopy!: () => void
      const pendingCopy = new Promise<void>((resolve) => { finishCopy = resolve })
      writeText.mockReturnValue(pendingCopy)
      mockBoxInput()
      press('x')
      expect(writeText).toHaveBeenCalledWith('!input')
      switch (source) {
        case 'data': xterm.handleData!('new text'); break
        case 'semantic key': xterm.handleKey!(new KeyboardEvent('keydown', { key: 'Enter' })); break
        case 'modified key': xterm.handleKey!(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true })); break
        case 'mac action': press('Backspace'); break
        case 'paste': {
          const event = new Event('paste', { cancelable: true })
          Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'pasted input' } })
          host.dispatchEvent(event)
          break
        }
        case 'mouse key':
          terminalState.alternateOn = true
          xterm.handleWheel!(new WheelEvent('wheel', { deltaY: 1 }))
          break
      }
      expect(onInput.mock.calls.length + onKey.mock.calls.length + onPaste.mock.calls.length).toBeGreaterThan(0)
      finishCopy()
      await pendingCopy
      await Promise.resolve()
      expect(onInput).not.toHaveBeenCalledWith('\x0b'.repeat(3) + '\x15'.repeat(3))
    },
  )

  it('copies selections exactly without clearing and leaves empty input alone', () => {
    const { onInput, writeText } = mount()
    xterm.selection = '  output\ntext  '
    expect(press('x').result).toBe(false)
    expect(writeText).toHaveBeenCalledWith(xterm.selection)
    expect(onInput).not.toHaveBeenCalled()
    xterm.selection = ''
    writeText.mockClear()
    xterm.active.getLine.mockReturnValue({ getCell: () => ({ getWidth: () => 1, isDim: () => true, getChars: () => 'g' }) })
    press('x')
    expect(writeText).not.toHaveBeenCalled()
    expect(onInput).not.toHaveBeenCalled()
  })

  it('does not send editing input or cut a disconnected pane', () => {
    const { onInput, writeText } = mount(false)
    press('z')
    press('x')
    expect(writeText).not.toHaveBeenCalled()
    expect(onInput).not.toHaveBeenCalled()
  })
})

describe('terminal paste dispatch', () => {
  it('dispatches a large allowed paste once without input-style chunking', () => {
    const dispatch = vi.fn()
    const data = 'x'.repeat(64 * 1024)

    expect(dispatchBoundedPaste(data, dispatch)).toBe('sent')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(data)
  })

  it('enforces the UTF-8 byte bound before dispatch', () => {
    const dispatch = vi.fn()
    const bounded = 'é'.repeat(MAX_PASTE_BYTES / 2)

    expect(dispatchBoundedPaste(bounded, dispatch)).toBe('sent')
    expect(dispatchBoundedPaste(`${bounded}x`, dispatch)).toBe('too-large')
    expect(dispatchBoundedPaste('', dispatch)).toBe('empty')
    expect(dispatchBoundedPaste('bad\0paste', dispatch)).toBe('invalid')
    expect(dispatch).toHaveBeenCalledOnce()
  })
})
