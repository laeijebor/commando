import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MAX_PASTE_BYTES,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type ClientMessage,
  type GroupLayoutPreset,
  type PaneLayoutCapacity,
  type SpecialKey,
} from '../shared/protocol.js'
import { parseSavedWorkspace } from './workspaces.js'

export const MAX_CLIENT_MESSAGE_BYTES = MAX_PASTE_BYTES * 6 + 1024
export const MAX_INPUT_BYTES = 8 * 1024
export const MAX_SUBSCRIBED_PANES = 64

const PANE_ID = /^%\d+$/
const WINDOW_ID = /^@\d+$/
const SESSION_ID = /^\$\d+$/
const GROUP_LAYOUT_PRESETS = new Set<GroupLayoutPreset>([
  'equal-grid',
  'full-then-halves',
  'two-full-two-halves',
  'lead-and-stack',
])
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

function parsePaneLayoutCapacity(value: unknown): PaneLayoutCapacity | null {
  if (
    !isRecord(value) ||
    !isPaneId(value.paneId) ||
    !boundedInteger(value.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS) ||
    !boundedInteger(value.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
  ) return null
  return { paneId: value.paneId, cols: value.cols, rows: value.rows }
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
      return {
        ok: true,
        message: { type: 'subscribe', paneIds: [...new Set(value.paneIds)] },
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
    case 'apply_window_layout': {
      const id = requestId(value.requestId)
      const paneIds = Array.isArray(value.paneIds) ? value.paneIds : []
      const capacities = Array.isArray(value.capacities)
        ? value.capacities.map(parsePaneLayoutCapacity)
        : []
      if (
        !id ||
        typeof value.windowId !== 'string' ||
        !WINDOW_ID.test(value.windowId) ||
        paneIds.length === 0 ||
        paneIds.length > MAX_SUBSCRIBED_PANES ||
        !paneIds.every(isPaneId) ||
        new Set(paneIds).size !== paneIds.length ||
        typeof value.preset !== 'string' ||
        !GROUP_LAYOUT_PRESETS.has(value.preset as GroupLayoutPreset) ||
        typeof value.stacked !== 'boolean' ||
        capacities.length !== paneIds.length ||
        capacities.some((capacity) => capacity === null) ||
        new Set(capacities.map((capacity) => capacity?.paneId)).size !== capacities.length ||
        capacities.some((capacity, index) => capacity?.paneId !== paneIds[index])
      ) {
        return {
          ok: false,
          error: 'Invalid authoritative window layout',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'apply_window_layout',
          windowId: value.windowId,
          paneIds: [...paneIds] as string[],
          preset: value.preset as GroupLayoutPreset,
          stacked: value.stacked,
          capacities: capacities as PaneLayoutCapacity[],
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
