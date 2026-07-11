import {
  MAX_PASTE_BYTES,
  type ClientMessage,
  type SpecialKey,
} from '../shared/protocol.js'
import { parseSavedWorkspace } from './workspaces.js'

export const MAX_CLIENT_MESSAGE_BYTES = MAX_PASTE_BYTES * 6 + 1024
export const MAX_INPUT_BYTES = 8 * 1024
export const MAX_SUBSCRIBED_PANES = 64

const PANE_ID = /^%\d+$/
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
