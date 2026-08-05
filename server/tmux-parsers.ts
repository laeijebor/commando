import type {
  CommandoSnapshot,
  PaneTerminalState,
  TmuxPane,
  TmuxSession,
  TmuxWindow,
} from '../shared/protocol.js'
import { parseWindowLayout } from '../shared/window-layout.js'

export const TMUX_FIELD_SEPARATOR = '\u001f'

export const SESSION_FORMAT = [
  '#{session_id}',
  '#{session_name}',
  '#{session_attached}',
].join(TMUX_FIELD_SEPARATOR)

export const WINDOW_FORMAT = [
  '#{window_id}',
  '#{window_index}',
  '#{session_id}',
  '#{window_name}',
  '#{window_active}',
  '#{window_layout}',
].join(TMUX_FIELD_SEPARATOR)

const PANE_TERMINAL_STATE_FIELDS = [
  '#{pane_width}',
  '#{pane_height}',
  '#{cursor_x}',
  '#{cursor_y}',
  '#{alternate_saved_x}',
  '#{alternate_saved_y}',
  '#{alternate_on}',
  '#{cursor_flag}',
  '#{cursor_shape}',
  '#{cursor_blinking}',
  '#{scroll_region_upper}',
  '#{scroll_region_lower}',
  '#{wrap_flag}',
  '#{origin_flag}',
  '#{insert_flag}',
  '#{keypad_flag}',
  '#{keypad_cursor_flag}',
  '#{mouse_any_flag}',
  '#{mouse_sgr_flag}',
  '#{pane_tabs}',
] as const

export const PANE_TERMINAL_STATE_FORMAT = [
  '#{pane_id}',
  ...PANE_TERMINAL_STATE_FIELDS,
].join(TMUX_FIELD_SEPARATOR)

export const PANE_FORMAT = [
  '#{pane_id}',
  '#{pane_index}',
  '#{window_id}',
  '#{session_id}',
  '#{pane_title}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_active}',
  '#{pane_dead}',
  ...PANE_TERMINAL_STATE_FIELDS,
  '#{pane_pid}',
].join(TMUX_FIELD_SEPARATOR)

const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/

function rows(output: string, fieldCount: number): string[][] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(TMUX_FIELD_SEPARATOR))
    .filter((fields) => fields.length === fieldCount)
}

function integer(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function flag(value: string): boolean | null {
  if (value === '1') return true
  if (value === '0') return false
  return null
}

function cursorShape(value: string): PaneTerminalState['cursorShape'] | null {
  if (
    value === 'default' ||
    value === 'block' ||
    value === 'underline' ||
    value === 'bar'
  ) {
    return value
  }
  return null
}

function paneTabs(value: string): number[] | null {
  if (value === '') return []
  const tabs = value.split(',').map(integer)
  if (tabs.some((tab) => tab === null)) return null
  return tabs as number[]
}

function savedCursorCoordinate(value: string, limit: number): number | null {
  // tmux exposes UINT_MAX until an alternate-screen cursor has been saved.
  if (value === '4294967295' || value === '18446744073709551615') return 0
  const coordinate = integer(value)
  if (coordinate === null || limit < 1) return null
  // A pane shrink does not clamp tmux's saved alternate-screen cursor.
  return Math.min(coordinate, limit - 1)
}

function parseTerminalState(fields: string[]): PaneTerminalState | null {
  if (fields.length !== PANE_TERMINAL_STATE_FIELDS.length) return null
  const [
    widthValue,
    heightValue,
    cursorXValue,
    cursorYValue,
    alternateSavedXValue,
    alternateSavedYValue,
    alternateOnValue,
    cursorVisibleValue,
    cursorShapeValue,
    cursorBlinkingValue,
    scrollRegionUpperValue,
    scrollRegionLowerValue,
    wrapFlagValue,
    originFlagValue,
    insertFlagValue,
    keypadFlagValue,
    keypadCursorFlagValue,
    mouseAnyFlagValue,
    mouseSgrFlagValue,
    paneTabsValue,
  ] = fields
  const width = integer(widthValue)
  const height = integer(heightValue)
  const cursorX = integer(cursorXValue)
  const cursorY = integer(cursorYValue)
  const alternateSavedX = width === null ? null : savedCursorCoordinate(alternateSavedXValue, width)
  const alternateSavedY = height === null ? null : savedCursorCoordinate(alternateSavedYValue, height)
  const alternateOn = flag(alternateOnValue)
  const cursorVisible = flag(cursorVisibleValue)
  const shape = cursorShape(cursorShapeValue)
  const cursorBlinking = flag(cursorBlinkingValue)
  const scrollRegionUpper = integer(scrollRegionUpperValue)
  const scrollRegionLower = integer(scrollRegionLowerValue)
  const wrapFlag = flag(wrapFlagValue)
  const originFlag = flag(originFlagValue)
  const insertFlag = flag(insertFlagValue)
  const keypadFlag = flag(keypadFlagValue)
  const keypadCursorFlag = flag(keypadCursorFlagValue)
  const mouseAnyFlag = flag(mouseAnyFlagValue)
  const mouseSgrFlag = flag(mouseSgrFlagValue)
  const tabs = paneTabs(paneTabsValue)

  if (
    width === null ||
    width < 1 ||
    height === null ||
    height < 1 ||
    cursorX === null ||
    cursorX > width ||
    cursorY === null ||
    cursorY >= height ||
    alternateSavedX === null ||
    alternateSavedY === null ||
    alternateOn === null ||
    cursorVisible === null ||
    shape === null ||
    cursorBlinking === null ||
    scrollRegionUpper === null ||
    scrollRegionLower === null ||
    scrollRegionUpper > scrollRegionLower ||
    scrollRegionLower >= height ||
    wrapFlag === null ||
    originFlag === null ||
    insertFlag === null ||
    keypadFlag === null ||
    keypadCursorFlag === null ||
    mouseAnyFlag === null ||
    mouseSgrFlag === null ||
    tabs === null
  ) {
    return null
  }

  if (tabs.some((tab, index) => tab >= width || (index > 0 && tab <= tabs[index - 1]))) {
    return null
  }

  return {
    width,
    height,
    // tmux uses cx === sx for a cursor pending an automatic wrap.
    cursorX: Math.min(cursorX, width - 1),
    cursorY,
    alternateSavedX,
    alternateSavedY,
    alternateOn,
    cursorVisible,
    cursorShape: shape,
    cursorBlinking,
    scrollRegionUpper,
    scrollRegionLower,
    wrapFlag,
    originFlag,
    insertFlag,
    keypadFlag,
    keypadCursorFlag,
    mouseAnyFlag,
    mouseSgrFlag,
    paneTabs: tabs,
  }
}

export function parseSessions(output: string): TmuxSession[] {
  const sessions: TmuxSession[] = []

  for (const [id, name, attachedValue] of rows(output, 3)) {
    const attachedClients = integer(attachedValue)
    if (!SESSION_ID.test(id) || attachedClients === null) continue

    sessions.push({
      id,
      name,
      attached: attachedClients > 0,
      activeWindowId: null,
      windowIds: [],
    })
  }

  return sessions
}

export function parseWindows(output: string): TmuxWindow[] {
  const windows: TmuxWindow[] = []

  for (const [id, indexValue, sessionId, name, activeValue, layout] of rows(output, 6)) {
    const index = integer(indexValue)
    const active = flag(activeValue)
    if (
      !WINDOW_ID.test(id) ||
      !SESSION_ID.test(sessionId) ||
      index === null ||
      active === null ||
      parseWindowLayout(layout) === null
    ) {
      continue
    }

    windows.push({ id, index, sessionId, name, active, layout, paneIds: [] })
  }

  return windows
}

export function parsePanes(output: string): TmuxPane[] {
  const panes: TmuxPane[] = []

  for (const fields of rows(output, 10 + PANE_TERMINAL_STATE_FIELDS.length)) {
    const [
      id,
      indexValue,
      windowId,
      sessionId,
      title,
      command,
      path,
      activeValue,
      deadValue,
    ] = fields
    const index = integer(indexValue)
    const processId = integer(fields.at(-1) ?? '')
    const active = flag(activeValue)
    const dead = flag(deadValue)
    const terminalState = parseTerminalState(
      fields.slice(9, 9 + PANE_TERMINAL_STATE_FIELDS.length),
    )

    if (
      !PANE_ID.test(id) ||
      !WINDOW_ID.test(windowId) ||
      !SESSION_ID.test(sessionId) ||
      index === null ||
      processId === null ||
      processId < 1 ||
      active === null ||
      dead === null ||
      terminalState === null
    ) {
      continue
    }

    panes.push({
      id,
      processId,
      index,
      windowId,
      sessionId,
      title,
      command,
      path,
      active,
      dead,
      ...terminalState,
    })
  }

  return panes
}

export type TmuxPaneProcess = {
  paneId: string
  sessionId: string
  processId: number
}

export function parsePaneProcesses(output: string): TmuxPaneProcess[] {
  const processes: TmuxPaneProcess[] = []
  for (const fields of rows(output, 10 + PANE_TERMINAL_STATE_FIELDS.length)) {
    const paneId = fields[0]
    const sessionId = fields[3]
    const processId = integer(fields.at(-1) ?? '')
    if (
      !PANE_ID.test(paneId) ||
      !SESSION_ID.test(sessionId) ||
      processId === null ||
      processId < 1
    ) continue
    processes.push({ paneId, sessionId, processId })
  }
  return processes
}

export function parsePaneTerminalState(
  output: string,
  paneId: string,
): PaneTerminalState | null {
  if (!PANE_ID.test(paneId)) return null
  for (const [id, ...fields] of rows(
    output,
    1 + PANE_TERMINAL_STATE_FIELDS.length,
  )) {
    if (id !== paneId) continue
    return parseTerminalState(fields)
  }
  return null
}

export function parseTmuxSnapshot(
  sessionOutput: string,
  windowOutput: string,
  paneOutput: string,
  revision: number,
  capturedAt: number,
): CommandoSnapshot {
  const sessions = parseSessions(sessionOutput)
  const sessionIds = new Set(sessions.map((session) => session.id))
  const windows = parseWindows(windowOutput)
    .filter((window) => sessionIds.has(window.sessionId))
    .sort((left, right) =>
      left.sessionId === right.sessionId
        ? left.index - right.index
        : left.sessionId.localeCompare(right.sessionId),
    )
  const windowIds = new Set(windows.map((window) => window.id))
  const panes = parsePanes(paneOutput)
    .filter(
      (pane) => sessionIds.has(pane.sessionId) && windowIds.has(pane.windowId),
    )
    .sort((left, right) =>
      left.windowId === right.windowId
        ? left.index - right.index
        : left.windowId.localeCompare(right.windowId),
    )

  for (const window of windows) {
    window.paneIds = panes
      .filter((pane) => pane.windowId === window.id)
      .map((pane) => pane.id)
  }

  for (const session of sessions) {
    const sessionWindows = windows.filter(
      (window) => window.sessionId === session.id,
    )
    session.windowIds = sessionWindows.map((window) => window.id)
    session.activeWindowId =
      sessionWindows.find((window) => window.active)?.id ?? null
  }

  sessions.sort((left, right) => left.name.localeCompare(right.name))

  return { revision, capturedAt, sessions, windows, panes, ports: [] }
}
