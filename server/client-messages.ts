import {
  MAX_INPUT_BYTES,
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
import {
  isInteractionId,
  parseAgentInteractionAnswer,
} from './agent-request-answers.js'
import { isCommandoTargetId } from '../shared/pane-target.js'
import { MAX_FILE_QUERY, isAgentId, isChatSwitchAction, type ChatImageRef, parseChatAnswer, parseChatImageRefs, parseChatQueueAction, parseChatSendOptions, parseChatSettingsChange, parseQueueIds } from '../shared/agent-chat.js'
import { parseChatMcpRequest } from '../shared/chat-mcp.js'
import { parseSavedWorkspace } from './workspaces.js'

export const MAX_CLIENT_MESSAGE_BYTES = MAX_PASTE_BYTES * 6 + 1024
export const MAX_SUBSCRIBED_PANES = 64

const PANE_RESET_BURST = 2
const PANE_RESET_REFILL_PER_SECOND = 0.5
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

type ParsedInputBytesMessage = Extract<ClientMessage, { type: 'input_bytes' }> & {
  bytes: Buffer
}

export type ParsedClientMessage =
  | Exclude<ClientMessage, { type: 'input_bytes' }>
  | ParsedInputBytesMessage

type ParseResult =
  | { ok: true; message: ParsedClientMessage }
  | { ok: false; error: string; requestId?: string }

export class TokenBucketRateLimiter {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly capacity = 80,
    private readonly refillPerSecond = 40,
    private readonly now = Date.now,
  ) {
    this.tokens = capacity
    this.lastRefill = now()
  }

  take(cost: number): boolean {
    const now = this.now()
    const elapsed = Math.max(0, now - this.lastRefill)
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (elapsed / 1_000) * this.refillPerSecond,
    )
    this.lastRefill = now
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

export type PaneResetDecision = 'allow' | 'coalesce' | 'rate_limited'

export class PaneResetGate {
  private readonly limiters = new Map<string, TokenBucketRateLimiter>()

  constructor(private readonly now = Date.now) {}

  decide(paneId: string, seedPending: boolean): PaneResetDecision {
    if (seedPending) return 'coalesce'
    let limiter = this.limiters.get(paneId)
    if (!limiter) {
      limiter = new TokenBucketRateLimiter(
        PANE_RESET_BURST,
        PANE_RESET_REFILL_PER_SECOND,
        this.now,
      )
      this.limiters.set(paneId, limiter)
    }
    return limiter.take(1) ? 'allow' : 'rate_limited'
  }

  forget(paneId: string): void {
    this.limiters.delete(paneId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : null
}

function parseCanonicalBase64(value: unknown): Buffer | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES ||
    bytes.toString('base64') !== value
  ) {
    return null
  }
  return bytes
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
    case 'mark_panes_seen': {
      if (
        !Array.isArray(value.paneIds) ||
        value.paneIds.length > MAX_SUBSCRIBED_PANES ||
        !value.paneIds.every(isPaneId)
      ) {
        return { ok: false, error: 'Invalid seen panes' }
      }
      return { ok: true, message: { type: 'mark_panes_seen', paneIds: [...new Set(value.paneIds)] } }
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
    case 'input_bytes': {
      const id = requestId(value.requestId)
      const bytes = parseCanonicalBase64(value.data)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        value.encoding !== 'base64' ||
        !bytes
      ) {
        return {
          ok: false,
          error: 'Invalid byte input message',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'input_bytes',
          paneId: value.paneId,
          data: value.data as string,
          encoding: 'base64',
          requestId: id,
          bytes,
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
    case 'request_pane_reset': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId)
        ? {
            ok: true,
            message: { type: 'request_pane_reset', paneId: value.paneId, requestId: id },
          }
        : {
            ok: false,
            error: 'Invalid pane reset request',
            requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
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
    case 'watch_interactions': {
      const id = requestId(value.requestId)
      return id && typeof value.enabled === 'boolean'
        ? {
            ok: true,
            message: { type: 'watch_interactions', enabled: value.enabled, requestId: id },
          }
        : {
            ok: false,
            error: 'Invalid interaction watch request',
            requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
          }
    }
    case 'answer_agent_request': {
      const id = requestId(value.requestId)
      const answer = parseAgentInteractionAnswer(value.answer)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        !isInteractionId(value.interactionId) ||
        !answer
      ) {
        return {
          ok: false,
          error: 'Invalid agent request answer',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: {
          type: 'answer_agent_request',
          paneId: value.paneId,
          interactionId: value.interactionId,
          answer,
          requestId: id,
        },
      }
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
    case 'watch_usage': {
      const id = requestId(value.requestId)
      if (!id || typeof value.enabled !== 'boolean') {
        return {
          ok: false,
          error: 'Invalid usage watch request',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return { ok: true, message: { type: 'watch_usage', enabled: value.enabled, requestId: id } }
    }
    case 'retry_agent_resume': {
      const id = requestId(value.requestId)
      const targetId = value.targetId
      if (!id || (targetId !== undefined && (typeof targetId !== 'string' || !isCommandoTargetId(targetId)))) {
        return {
          ok: false,
          error: 'Invalid agent resume retry',
          requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        }
      }
      return {
        ok: true,
        message: { type: 'retry_agent_resume', ...(targetId === undefined ? {} : { targetId }), requestId: id },
      }
    }
    case 'refresh_usage': {
      const id = requestId(value.requestId)
      return id
        ? { ok: true, message: { type: 'refresh_usage', requestId: id } }
        : { ok: false, error: 'Invalid usage refresh request' }
    }
    case 'chat_send': {
      const id = requestId(value.requestId)
      const images = value.images === undefined ? [] : parseChatImageRefs(value.images)
      const options = parseChatSendOptions(value)
      if (
        !id ||
        !isPaneId(value.paneId) ||
        typeof value.text !== 'string' ||
        !images ||
        !options ||
        (value.text.trim().length === 0 && images.length === 0) ||
        value.text.includes('\0') ||
        Buffer.byteLength(value.text, 'utf8') > MAX_PASTE_BYTES
      ) {
        return { ok: false, error: 'Invalid chat message', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
      }
      return { ok: true, message: { type: 'chat_send', paneId: value.paneId, text: value.text, ...(images.length ? { images } : {}), ...options, requestId: id } }
    }
    case 'chat_queue': {
      const id = requestId(value.requestId)
      const change = parseChatQueueAction(value)
      return id && isPaneId(value.paneId) && change
        ? { ok: true, message: { type: 'chat_queue', paneId: value.paneId, requestId: id, ...change } }
        : { ok: false, error: 'Invalid queue change', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_external_stop': {
      const id = requestId(value.requestId)
      const runId = typeof value.runId === 'string' && /^external-[0-9a-f-]{36}$/.test(value.runId) ? value.runId : null
      return id && isPaneId(value.paneId) && runId
        ? { ok: true, message: { type: 'chat_external_stop', paneId: value.paneId, runId, requestId: id } }
        : { ok: false, error: 'Invalid external agent stop request', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_task': {
      const id = requestId(value.requestId)
      const toolUseId = typeof value.toolUseId === 'string' && value.toolUseId.length > 0 && value.toolUseId.length <= 200 ? value.toolUseId : null
      return id && isPaneId(value.paneId) && (value.action === 'stop' || value.action === 'background') && isAgentId(value.agentId) && toolUseId
        ? { ok: true, message: { type: 'chat_task', paneId: value.paneId, action: value.action, agentId: value.agentId, toolUseId, requestId: id } }
        : { ok: false, error: 'Invalid subagent action', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_subagent_transcript': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId) && isAgentId(value.agentId)
        ? { ok: true, message: { type: 'chat_subagent_transcript', paneId: value.paneId, agentId: value.agentId, requestId: id } }
        : { ok: false, error: 'Invalid subagent transcript request', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_mcp': {
      const id = requestId(value.requestId)
      const request = parseChatMcpRequest(value.request)
      return id && isPaneId(value.paneId) && request
        ? { ok: true, message: { type: 'chat_mcp', paneId: value.paneId, request, requestId: id } }
        : { ok: false, error: 'Invalid MCP request', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_file_search': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId) && typeof value.query === 'string' && value.query.length <= MAX_FILE_QUERY && !value.query.includes('\0')
        ? { ok: true, message: { type: 'chat_file_search', paneId: value.paneId, query: value.query, requestId: id } }
        : { ok: false, error: 'Invalid file search', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_interrupt': {
      const id = requestId(value.requestId)
      const dropQueued = parseQueueIds(value.dropQueued)
      return id && isPaneId(value.paneId) && dropQueued !== null
        ? { ok: true, message: { type: 'chat_interrupt', paneId: value.paneId, requestId: id, ...(dropQueued?.length ? { dropQueued } : {}) } }
        : { ok: false, error: 'Invalid chat interrupt', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_restart': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId)
        ? { ok: true, message: { type: 'chat_restart', paneId: value.paneId, requestId: id } }
        : { ok: false, error: 'Invalid chat restart', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_answer': {
      const id = requestId(value.requestId)
      const answer = parseChatAnswer(value.answer)
      const chatRequestId = typeof value.chatRequestId === 'string' && value.chatRequestId.length > 0 && value.chatRequestId.length <= 200
        ? value.chatRequestId
        : null
      if (!id || !isPaneId(value.paneId) || !answer || !chatRequestId) {
        return { ok: false, error: 'Invalid chat answer', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
      }
      return { ok: true, message: { type: 'chat_answer', paneId: value.paneId, chatRequestId, answer, requestId: id } }
    }
    case 'chat_configure': {
      const id = requestId(value.requestId)
      const settings = parseChatSettingsChange(value.settings)
      return id && isPaneId(value.paneId) && settings
        ? { ok: true, message: { type: 'chat_configure', paneId: value.paneId, settings, requestId: id } }
        : { ok: false, error: 'Invalid chat settings', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_switch': {
      const id = requestId(value.requestId)
      const draft = value.draft === undefined ? undefined : parseSwitchDraft(value.draft)
      return id && isPaneId(value.paneId) && isChatSwitchAction(value.action) && draft !== null
        ? { ok: true, message: { type: 'chat_switch', paneId: value.paneId, action: value.action, ...(draft ? { draft } : {}), requestId: id } }
        : { ok: false, error: 'Invalid switch to Claude Code', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_return': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId)
        ? { ok: true, message: { type: 'chat_return', paneId: value.paneId, requestId: id } }
        : { ok: false, error: 'Invalid return to the chat', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_carry_taken': {
      const id = requestId(value.requestId)
      const carryId = typeof value.carryId === 'string' && value.carryId.length > 0 && value.carryId.length <= 200 ? value.carryId : null
      const images = value.images === undefined || (Number.isInteger(value.images) && (value.images as number) >= 0 && (value.images as number) <= 1000) ? value.images as number | undefined : null
      return id && isPaneId(value.paneId) && carryId && images !== null
        ? { ok: true, message: { type: 'chat_carry_taken', paneId: value.paneId, carryId, ...(images === undefined ? {} : { images }), requestId: id } }
        : { ok: false, error: 'Invalid carried draft', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    case 'chat_history': {
      const id = requestId(value.requestId)
      return id && isPaneId(value.paneId)
        ? { ok: true, message: { type: 'chat_history', paneId: value.paneId, requestId: id } }
        : { ok: false, error: 'Invalid chat history request', requestId: typeof value.requestId === 'string' ? value.requestId : undefined }
    }
    default:
      return { ok: false, error: 'Unsupported message type' }
  }
}

/** A chat's unsent draft, sent with its switch to Claude Code; null when malformed. */
function parseSwitchDraft(value: unknown): { text: string; images: ChatImageRef[] } | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Record<string, unknown>
  const images = draft.images === undefined ? [] : parseChatImageRefs(draft.images)
  if (typeof draft.text !== 'string' || draft.text.includes('\0') || Buffer.byteLength(draft.text, 'utf8') > MAX_PASTE_BYTES || !images) return null
  return { text: draft.text, images }
}
