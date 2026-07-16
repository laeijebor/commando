import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SCROLLBACK_LINES } from '../shared/protocol.js'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>(
    'node:child_process',
  )
  return { ...actual, execFile: execFileMock }
})

import {
  ControlModeLineBuffer,
  capturePaneProcess,
  capturePaneSeedProcess,
  capturePausedPane,
  decodeControlEscapes,
  encodeLiteralInputCommand,
  encodeSpecialKeyCommand,
  normalizeCaptureLineEndings,
  parseControlModeLine,
} from './tmux-control.js'
import { PANE_TERMINAL_STATE_FORMAT, TMUX_FIELD_SEPARATOR } from './tmux-parsers.js'

afterEach(() => {
  execFileMock.mockReset()
})

describe('tmux control-mode parsing', () => {
  it('decodes control-mode octal escapes without interpreting raw bytes as UTF-8', () => {
    const encoded = Buffer.concat([
      Buffer.from('plain\\000\\033\\134'),
      Buffer.from([0xff]),
    ])

    expect([...decodeControlEscapes(encoded)]).toEqual([
      ...Buffer.from('plain'),
      0,
      0x1b,
      0x5c,
      0xff,
    ])
    expect(decodeControlEscapes(Buffer.from('bad\\12x'))).toEqual(
      Buffer.from('bad\\12x'),
    )
    expect(decodeControlEscapes(Buffer.from('bad\\400'))).toEqual(
      Buffer.from('bad\\400'),
    )
  })

  it('attributes pane output and preserves non-UTF8 payload bytes', () => {
    const line = Buffer.concat([
      Buffer.from('%output %42 A\\015\\012\\377'),
      Buffer.from([0xfe]),
    ])

    expect(parseControlModeLine(line)).toEqual({
      type: 'output',
      paneId: '%42',
      data: Buffer.from([0x41, 0x0d, 0x0a, 0xff, 0xfe]),
    })
    expect(parseControlModeLine(Buffer.from('%begin 12 34 1'))).toEqual({
      type: 'begin',
      id: '12 34 1',
    })
  })

  it('buffers partial lines and handles multiple notifications in one chunk', () => {
    const lines: Buffer[] = []
    const parser = new ControlModeLineBuffer((line) => lines.push(Buffer.from(line)))

    parser.push(Buffer.from('%output %1 hel'))
    parser.push(Buffer.from('lo\\012\n%window-add @2\r\npartial'))
    parser.push(Buffer.from('-line\n'))

    expect(lines.map((line) => line.toString('latin1'))).toEqual([
      '%output %1 hello\\012',
      '%window-add @2',
      'partial-line',
    ])
  })

  it('normalizes captured screen rows to terminal carriage-return line feeds', () => {
    expect(normalizeCaptureLineEndings(Buffer.from('one\ntwo\r\nthree'))).toEqual(
      Buffer.from('one\r\ntwo\r\nthree'),
    )
  })

  it('removes only the synthetic final newline from a full-height capture', () => {
    expect(normalizeCaptureLineEndings(Buffer.from('one\ntwo\nthree\n'))).toEqual(
      Buffer.from('one\r\ntwo\r\nthree'),
    )
    expect(normalizeCaptureLineEndings(Buffer.from('one\n\n'))).toEqual(
      Buffer.from('one\r\n'),
    )
  })

  it('rejects a complete or partial line beyond its configured bound', () => {
    const parser = new ControlModeLineBuffer(() => undefined, 4)
    expect(() => parser.push(Buffer.from('12345\n'))).toThrow(/buffer limit/)

    const partialParser = new ControlModeLineBuffer(() => undefined, 4)
    expect(() => partialParser.push(Buffer.from('12345'))).toThrow(/buffer limit/)
  })
})

describe('tmux pane capture', () => {
  it('returns tmux-looking capture rows directly from a one-shot process', async () => {
    const capture = Buffer.from(
      '%output %42 literal pane text\n%begin 12 34 1\n%end 12 34 1\n',
    )
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (
        error: Error | null,
        stdout: Buffer,
        stderr: Buffer,
      ) => void
      callback(null, capture, Buffer.alloc(0))
      return {}
    })

    await expect(capturePaneProcess(['-L', 'commando-test'], '%42')).resolves.toEqual(
      capture,
    )
    expect(execFileMock).toHaveBeenCalledWith(
      'tmux',
      [
        '-L',
        'commando-test',
        'capture-pane',
        '-p',
        '-e',
        '-N',
        '-S',
        `-${TERMINAL_SCROLLBACK_LINES}`,
        '-t',
        '%42',
      ],
      expect.objectContaining({ encoding: null, shell: false }),
      expect.any(Function),
    )
  })

  it('captures fresh terminal state with the pane seed', async () => {
    const capture = Buffer.from('screen row\n')
    const events: string[] = []
    execFileMock.mockImplementation((...args: unknown[]) => {
      events.push('capture')
      const callback = args[3] as (
        error: Error | null,
        stdout: Buffer,
        stderr: Buffer,
      ) => void
      callback(null, capture, Buffer.alloc(0))
      return {}
    })
    const stateOutput = [
      '%42',
      '120',
      '40',
      '17',
      '8',
      '4',
      '5',
      '1',
      '0',
      'bar',
      '1',
      '2',
      '38',
      '0',
      '1',
      '1',
      '1',
      '1',
      '1',
      '0',
      '8,16,24',
    ].join(TMUX_FIELD_SEPARATOR)
    const command = vi.fn(async () => {
      events.push('metadata')
      return Buffer.from(`${stateOutput}\n`)
    })

    await expect(capturePaneSeedProcess([], '%42', command)).resolves.toEqual({
      capture,
      normalCapture: capture,
      terminalState: expect.objectContaining({
        width: 120,
        cursorX: 17,
        alternateSavedX: 4,
        alternateOn: true,
        cursorVisible: false,
        cursorShape: 'bar',
        paneTabs: [8, 16, 24],
      }),
    })
    expect(events).toEqual(['metadata', 'capture', 'capture', 'metadata'])
    expect(command).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenCalledWith(
      `display-message -p -t %42 -F '${PANE_TERMINAL_STATE_FORMAT}'`,
    )
  })

  it('rejects malformed fresh terminal state', async () => {
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args[3] as (
        error: Error | null,
        stdout: Buffer,
        stderr: Buffer,
      ) => void
      callback(null, Buffer.from('screen row\n'), Buffer.alloc(0))
      return {}
    })

    await expect(
      capturePaneSeedProcess([], '%42', async () => Buffer.from('%42\u001f80\n')),
    ).rejects.toThrow(/invalid pane terminal state/)
  })

  it('retries when pane geometry changes during capture', async () => {
    // Supply complete valid mode fields while changing only width.
    const valid = (width: string) => [
      '%42', width, '24', '0', '0', '0', '0', '0', '1', 'default', '0', '0', '23',
      '1', '0', '0', '0', '0', '0', '0', '',
    ].join(TMUX_FIELD_SEPARATOR)
    const states = [valid('80'), valid('81'), valid('81'), valid('81')]
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: Buffer, stderr: Buffer) => void
      callback(null, Buffer.from('screen\n'), Buffer.alloc(0))
      return {}
    })
    const command = vi.fn(async () => Buffer.from(`${states.shift() ?? valid('81')}\n`))

    await expect(capturePaneSeedProcess([], '%42', command)).resolves.toMatchObject({
      terminalState: { width: 81 },
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('pauses, captures, delivers the reset, then continues pane output', async () => {
    const events: string[] = []
    const capture = Buffer.from('%output %7 screen row\n%begin 1 2 3\n')

    await expect(
      capturePausedPane(
        '%7',
        async (command) => {
          events.push(command)
          return Buffer.alloc(0)
        },
        async () => {
          events.push('capture')
          return capture
        },
        async (output) => {
          events.push(`deliver:${output.toString('utf8')}`)
        },
      ),
    ).resolves.toEqual(capture)

    expect(events).toEqual([
      "refresh-client -A '%7:pause'",
      'capture',
      `deliver:${capture.toString('utf8')}`,
      "refresh-client -A '%7:continue'",
    ])
  })

  it('continues pane output when reset delivery fails', async () => {
    const commands: string[] = []

    await expect(
      capturePausedPane(
        '%8',
        async (command) => {
          commands.push(command)
          return Buffer.alloc(0)
        },
        async () => Buffer.from('seed\n'),
        () => {
          throw new Error('delivery failed')
        },
      ),
    ).rejects.toThrow('delivery failed')
    expect(commands).toEqual([
      "refresh-client -A '%8:pause'",
      "refresh-client -A '%8:continue'",
    ])
  })
})

describe('tmux control-mode input encoding', () => {
  it('encodes literal UTF-8 as fixed hexadecimal byte arguments', () => {
    expect(encodeLiteralInputCommand('%7', 'Aé\n')).toBe(
      'send-keys -H -t %7 41 c3 a9 0a',
    )
    expect(encodeLiteralInputCommand('%7', '')).toBeNull()
    expect(() => encodeLiteralInputCommand('%7', 'x\0y')).toThrow(/null byte/)
    expect(() => encodeLiteralInputCommand('7', 'x')).toThrow(/pane id/)
  })

  it('uses only the mapped special-key token', () => {
    expect(encodeSpecialKeyCommand('%9', 'Backspace')).toBe(
      'send-keys -t %9 BSpace',
    )
    expect(encodeSpecialKeyCommand('%9', 'C-c')).toBe('send-keys -t %9 C-c')
    expect(encodeSpecialKeyCommand('%9', 'Insert')).toBe('send-keys -t %9 IC')
    expect(encodeSpecialKeyCommand('%9', 'Delete')).toBe('send-keys -t %9 DC')
    expect(encodeSpecialKeyCommand('%9', 'PageUp')).toBe('send-keys -t %9 PPage')
    expect(encodeSpecialKeyCommand('%9', 'PageDown')).toBe('send-keys -t %9 NPage')
    expect(encodeSpecialKeyCommand('%9', 'F12')).toBe('send-keys -t %9 F12')
    expect(() =>
      encodeSpecialKeyCommand('%9', 'not-a-key' as never),
    ).toThrow(/Unsupported/)
  })
})
