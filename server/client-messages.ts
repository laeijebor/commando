import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MAX_PASTE_BYTES,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type ClientMessage,
  type LayoutSpec,
  type SpecialKey,
} from '../shared/protocol.js'
import {
  MAX_LAYOUT_SPEC_DEPTH,
  MAX_LAYOUT_SPEC_PANES,
} from '../shared/window-layout.js'
import { parseSavedWorkspace } from './workspaces.js'

export const MAX_CLIENT_MESSAGE_BYTES = MAX_PASTE_BYTES * 6 + 1024
export const MAX_INPUT_BYTES = 8 * 1024
export const MAX_SUBSCRIBED_PANES = 64

const PANE_ID = /^%\d+$/
const WINDOW_ID = /^@\d+$/
const SESSION_ID = /^\$\d+$/
const SPECIAL_KEYS = new Set<SpecialKey>([
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
])

type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string; requestId?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : null
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function parseLayoutSpecNode(value: unknown, depth: number, seen: Set<string>): LayoutSpec | null {
  if (!isRecord(value) || depth > MAX_LAYOUT_SPEC_DEPTH) return null
  if (value.kind === 'pane') {
    if (
      !isPaneId(value.paneId) ||
      seen.has(value.paneId) ||
      seen.size >= MAX_LAYOUT_SPEC_PANES ||
      !boundedInteger(value.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS) ||
      !boundedInteger(value.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    ) return null
    seen.add(value.paneId)
    return { kind: 'pane', paneId: value.paneId, cols: value.cols, rows: value.rows }
  }
  if (value.kind === 'split') {
    if (
      (value.direction !== 'row' && value.direction !== 'column') ||
      !Array.isArray(value.children) ||
      value.children.length < 2 ||
      value.children.length > MAX_LAYOUT_SPEC_PANES
    ) return null
    const children: LayoutSpec[] = []
    for (const child of value.children) {
      const parsed = parseLayoutSpecNode(child, depth + 1, seen)
      if (!parsed) return null
      children.push(parsed)
    }
    return { kind: 'split', direction: value.direction, children }
  }
  return null
}

function parseLayoutSpec(value: unknown): LayoutSpec | null {
  return parseLayoutSpecNode(value, 1, new Set())
}

export function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && PANE_ID.test(value)
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value)
}

export function parseClientMessage(value: unknown): ParseResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, error: 'Message must be an object with a type' }
  }

  switch (value.type) {
    case 'subscribe': {
      if (
        !Array.isArray(value.paneIds) ||
        value.paneIds.length > MAX_SUBSCRIBED_PANES ||
        !value.paneIds.every(isPaneId)
      ) {
        return { ok: false, error: 'Invalid pane subscription' }
      }
      const statusPaneIds = value.statusPaneIds ?? []
      if (
        !Array.isArray(statusPaneIds) ||
        statusPaneIds.length > MAX_SUBSCRIBED_PANES ||
        !statusPaneIds.every(isPaneId)
      ) {
        return { ok: false, error: 'Invalid pane subscription' }
      }
      return {
        ok: true,
        message: {
          type: 'subscribe',
          paneIds: [...new Set(value.paneIds)],
          statusPaneIds: [...new Set(statusPaneIds)],
        },
      }
    }
    case 'input': {
      const id = requestId(value.requestId)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        typeof value.data !== 'string' ||
        value.data.includes('\0') ||
        Buffer.byteLength(value.data, 'utf8') > MAX_INPUT_BYTES
      ) {
        return {
          ok: false,
          error: 'Invalid input message',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'input',
          paneId: value.paneId,
          data: value.data,
          requestId: id,
        },
      }
    }
    case 'paste': {
      const id = requestId(value.requestId)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        typeof value.data !== 'string' ||
        value.data.length === 0 ||
        value.data.includes('\0') ||
        Buffer.byteLength(value.data, 'utf8') > MAX_PASTE_BYTES
      ) {
        return {
          ok: false,
          error: 'Invalid paste message',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'paste',
          paneId: value.paneId,
          data: value.data,
          requestId: id,
        },
      }
    }
    case 'key': {
      const id = requestId(value.requestId)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        typeof value.key !== 'string' ||
        !SPECIAL_KEYS.has(value.key as SpecialKey)
      ) {
        return {
          ok: false,
          error: 'Invalid special key message',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'key',
          paneId: value.paneId,
          key: value.key as SpecialKey,
          requestId: id,
        },
      }
    }
    case 'resize_pane': {
      const id = requestId(value.requestId)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        !boundedInteger(value.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS) ||
        !boundedInteger(value.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
      ) {
        return {
          ok: false,
          error: 'Invalid pane resize message',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'resize_pane',
          paneId: value.paneId,
          cols: value.cols,
          rows: value.rows,
          requestId: id,
        },
      }
    }
    case 'release_resize': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId)
        ? {
            ok: true,
            message: { type: 'release_resize', paneId: value.paneId, requestId: id },
          }
        : {
            ok: false,
            error: 'Invalid pane resize release',
            requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
          }
    }
    case 'apply_window_layout':
    case 'set_window_layout': {
      const id = requestId(value.requestId)
      const spec = parseLayoutSpec(value.spec)
      if (
        !id ||
        typeof value.windowId !== 'string' ||
        !WINDOW_ID.test(value.windowId) ||
        !spec
      ) {
        return {
          ok: false,
          error: 'Invalid window layout',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: value.type === 'apply_window_layout' ? 'apply_window_layout' : 'set_window_layout',
          windowId: value.windowId,
          spec,
          requestId: id,
        },
      }
    }
    case 'release_all_resizes': {
      const id = requestId(value.requestId)
      return id
        ? { ok: true, message: { type: 'release_all_resizes', requestId: id } }
        : { ok: false, error: 'Invalid resize release request' }
    }
    case 'refresh': {
      const id = requestId(value.requestId)
      return id
        ? { ok: true, message: { type: 'refresh', requestId: id } }
        : { ok: false, error: 'Invalid refresh request id' }
    }
    case 'load_workspace': {
      const id = requestId(value.requestId)
      return isSessionId(value.sessionId) && id
        ? {
            ok: true,
            message: {
              type: 'load_workspace',
              sessionId: value.sessionId,
              requestId: id,
            },
          }
        : { ok: false, error: 'Invalid workspace load request' }
    }
    case 'save_workspace': {
      const id = requestId(value.requestId)
      const workspace = parseSavedWorkspace(value.workspace)
      if (!id || !workspace) {
        return {
          ok: false,
          error: 'Invalid workspace save request',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: { type: 'save_workspace', workspace, requestId: id },
      }
    }
    default:
      return { ok: false, error: 'Unsupported message type' }
  }
}
