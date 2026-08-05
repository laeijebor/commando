import { describe, expect, it } from 'vitest'
import {
  TMUX_FIELD_SEPARATOR,
  parsePaneProcesses,
  parsePaneTerminalState,
  parsePanes,
  parseTmuxSnapshot,
} from './tmux-parsers.js'

const row = (...fields: string[]): string => fields.join(TMUX_FIELD_SEPARATOR)

const defaultTerminalState = [
  '0',
  '0',
  '0',
  '1',
  'default',
  '0',
  '0',
  '23',
  '1',
  '0',
  '0',
  '0',
  '0',
  '0',
  '0',
  '',
]

function paneRow(
  ...fields: [
    id: string,
    index: string,
    windowId: string,
    sessionId: string,
    title: string,
    command: string,
    path: string,
    active: string,
    dead: string,
    width: string,
    height: string,
    cursorX: string,
    cursorY: string,
    terminalState?: string[],
  ]
): string {
  const terminalState = Array.isArray(fields.at(-1))
    ? (fields.pop() as string[])
    : undefined
  return row(...(fields as string[]), ...(terminalState ?? defaultTerminalState), '1234')
}

describe('tmux format parsers', () => {
  it('builds relationships from stable tmux ids', () => {
    const snapshot = parseTmuxSnapshot(
      `${row('$1', 'work', '2')}\n${row('$2', 'other', '0')}\n`,
      [
        row('@3', '1', '$1', 'editor', '1', 'dbde,200x50,0,0{100x50,0,0,9,99x50,101,0,8}'),
        row('@4', '2', '$1', 'tests', '0', 'aaaa,100x30,0,0,10'),
        row('@5', '0', '$2', 'shell', '1', 'bbbb,90x24,0,0,11'),
        row('@6', '3', '$1', 'broken', '0', 'not-a-layout'),
      ].join('\n'),
      [
        paneRow('%8', '1', '@3', '$1', 'Claude Code', 'claude', '/repo', '1', '0', '120', '40', '17', '8'),
        paneRow('%9', '0', '@3', '$1', 'shell', 'zsh', '/repo', '0', '0', '80', '40', '4', '3'),
        paneRow('%10', '0', '@4', '$1', 'tests', 'node', '/repo', '1', '0', '100', '30', '0', '29'),
        paneRow('%11', '0', '@5', '$2', 'shell', 'zsh', '/tmp', '1', '0', '90', '24', '12', '23'),
      ].join('\n'),
      7,
      1234,
    )

    expect(snapshot.revision).toBe(7)
    expect(snapshot.sessions[0]).toMatchObject({
      id: '$2',
      activeWindowId: '@5',
      windowIds: ['@5'],
    })
    expect(snapshot.sessions[1]).toMatchObject({
      id: '$1',
      attached: true,
      activeWindowId: '@3',
      windowIds: ['@3', '@4'],
    })
    expect(snapshot.windows.find((window) => window.id === '@3')?.paneIds).toEqual([
      '%9',
      '%8',
    ])
    expect(snapshot.windows.find((window) => window.id === '@3')?.layout).toBe(
      'dbde,200x50,0,0{100x50,0,0,9,99x50,101,0,8}',
    )
    expect(snapshot.windows.some((window) => window.id === '@6')).toBe(false)
    expect(snapshot.panes.find((pane) => pane.id === '%8')).toMatchObject({
      processId: 1234,
      cursorX: 17,
      cursorY: 8,
      cursorVisible: true,
      cursorShape: 'default',
      paneTabs: [],
    })
    expect(snapshot.ports).toEqual([])
    expect(parsePaneProcesses(paneRow('%8', '1', '@3', '$1', 'Claude Code', 'claude', '/repo', '1', '0', '120', '40', '17', '8'))).toEqual([
      { paneId: '%8', sessionId: '$1', processId: 1234 },
    ])
  })

  it('parses tmux 3.6 terminal mode state and tab stops', () => {
    const terminalFields = [
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
    ]
    const output = paneRow(
      '%7',
      '0',
      '@1',
      '$1',
      'editor',
      'nvim',
      '/repo',
      '1',
      '0',
      '120',
      '40',
      '17',
      '8',
      terminalFields,
    )

    expect(parsePanes(output)[0]).toMatchObject({
      alternateOn: true,
      alternateSavedX: 4,
      alternateSavedY: 5,
      cursorVisible: false,
      cursorShape: 'bar',
      cursorBlinking: true,
      scrollRegionUpper: 2,
      scrollRegionLower: 38,
      wrapFlag: false,
      originFlag: true,
      insertFlag: true,
      keypadFlag: true,
      keypadCursorFlag: true,
      mouseAnyFlag: true,
      mouseSgrFlag: false,
      paneTabs: [8, 16, 24],
    })
    expect(
      parsePaneTerminalState(
        row('%7', '120', '40', '17', '8', ...terminalFields),
        '%7',
      ),
    ).toMatchObject({ cursorShape: 'bar', paneTabs: [8, 16, 24] })
  })

  it('normalizes unset alternate-screen cursor sentinels for new shell panes', () => {
    const terminalFields = [
      '4294967295',
      '4294967295',
      ...defaultTerminalState.slice(2),
    ]
    const output = paneRow(
      '%2',
      '0',
      '@1',
      '$1',
      'shell',
      'zsh',
      '/repo',
      '1',
      '0',
      '80',
      '24',
      '1',
      '2',
      terminalFields,
    )

    expect(parsePanes(output)[0]).toMatchObject({
      id: '%2',
      alternateSavedX: 0,
      alternateSavedY: 0,
      alternateOn: false,
    })
  })

  it('normalizes valid tmux cursor positions outside the resized grid', () => {
    const output = paneRow(
      '%63',
      '2',
      '@1',
      '$1',
      'agent',
      'opencode',
      '/repo',
      '0',
      '0',
      '80',
      '24',
      '80',
      '23',
      [
        '120',
        '139',
        ...defaultTerminalState.slice(2),
      ],
    )

    expect(parsePanes(output)[0]).toMatchObject({
      id: '%63',
      cursorX: 79,
      cursorY: 23,
      alternateSavedX: 79,
      alternateSavedY: 23,
    })
  })

  it('drops malformed and unstable pane records', () => {
    const output = [
      paneRow('%1', '0', '@1', '$1', 'ok', 'zsh', '/tmp', '1', '0', '80', '24', '1', '2'),
      paneRow('pane-1', '0', '@1', '$1', 'bad', 'zsh', '/tmp', '1', '0', '80', '24', '0', '0'),
      paneRow('%2', 'NaN', '@1', '$1', 'bad', 'zsh', '/tmp', '1', '0', '80', '24', '0', '0'),
      paneRow('%3', '0', '@1', '$1', 'bad', 'zsh', '/tmp', 'yes', '0', '80', '24', '0', '0'),
      paneRow('%4', '0', '@1', '$1', 'bad', 'zsh', '/tmp', '1', '0', '80', '24', 'x', '0'),
      paneRow('%5', '0', '@1', '$1', 'bad', 'zsh', '/tmp', '1', '0', '80', '24', '0', '0', [
        ...defaultTerminalState.slice(0, 4),
        'beam',
        ...defaultTerminalState.slice(5),
      ]),
      paneRow('%6', '0', '@1', '$1', 'bad', 'zsh', '/tmp', '1', '0', '80', '24', '0', '0', [
        ...defaultTerminalState.slice(0, 15),
        '8,nope',
      ]),
      'too-few-fields',
    ].join('\n')

    expect(parsePanes(output).map((pane) => pane.id)).toEqual(['%1'])
    expect(
      parsePaneTerminalState(
        row('%1', '80', '24', '0', '0', ...defaultTerminalState.slice(0, 15), '8,nope'),
        '%1',
      ),
    ).toBeNull()
  })
})
