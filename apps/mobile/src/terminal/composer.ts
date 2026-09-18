import type { SpecialKey } from '@commando/protocol'

import { inputFits, pasteFits } from '../daemon/limits'
import type { KeyBarAction } from './keyBar'

/**
 * One thing to send to a pane. The composer turns what was typed into a short
 * list of these, which keeps the ordering — the part that actually matters —
 * out of the React component and under test.
 */
export type ComposerOp =
  | { kind: 'paste'; data: string }
  | { kind: 'input'; data: string }
  | { kind: 'key'; key: SpecialKey }

export type ComposerMode = 'prompt' | 'raw'

/** Just enough of `DaemonClient` for the composer; tests pass a double. */
export type PaneSender = {
  paste: (paneId: string, data: string) => string | null
  input: (paneId: string, data: string) => string | null
  key: (paneId: string, key: SpecialKey) => string | null
}

export type SendResult = 'sent' | 'empty' | 'too-large' | 'offline'

/**
 * Prompt mode is the spec's rule: a bracketed `paste` with the whole message
 * and then Enter, so Claude Code receives a multi-line prompt as one turn
 * instead of submitting it line by line. Trailing whitespace is dropped so the
 * paste does not smuggle in an extra newline before that Enter.
 */
export function composerOps(text: string, mode: ComposerMode): ComposerOp[] {
  if (mode === 'raw') return rawOps(text)
  const body = text.replace(/\s+$/u, '')
  if (body.length === 0) return []
  return [{ kind: 'paste', data: body }, { kind: 'key', key: 'Enter' }]
}

/**
 * Raw mode is for TUIs that read a key at a time: every keystroke goes out as
 * `input` the moment it is typed, and a newline becomes a real Enter.
 */
export function rawOps(text: string): ComposerOp[] {
  if (text.length === 0) return []
  const ops: ComposerOp[] = []
  const segments = text.split('\n')
  segments.forEach((segment, index) => {
    if (segment.length > 0) ops.push({ kind: 'input', data: segment })
    if (index < segments.length - 1) ops.push({ kind: 'key', key: 'Enter' })
  })
  return ops
}

/** A key-bar tap, with the clipboard already read for the paste button. */
export function keyBarOps(action: KeyBarAction, clipboard?: string): ComposerOp[] {
  if (action.kind === 'key') return [{ kind: 'key', key: action.key }]
  if (action.kind === 'input') return [{ kind: 'input', data: action.data }]
  const text = clipboard ?? ''
  return text.length > 0 ? [{ kind: 'paste', data: text }] : []
}

/**
 * Applies ops in order and stops at the first one the daemon would refuse, so
 * an oversized paste never leaves a bare Enter behind.
 */
export function sendOps(sender: PaneSender, paneId: string, ops: readonly ComposerOp[]): SendResult {
  if (ops.length === 0) return 'empty'
  for (const op of ops) {
    if (op.kind === 'paste' && !pasteFits(op.data)) return 'too-large'
    if (op.kind === 'input' && !inputFits(op.data)) return 'too-large'
  }
  for (const op of ops) {
    const requestId =
      op.kind === 'paste'
        ? sender.paste(paneId, op.data)
        : op.kind === 'input'
          ? sender.input(paneId, op.data)
          : sender.key(paneId, op.key)
    // `send` returns null only when the socket is down, and a half-delivered
    // sequence is still a failed send as far as the composer is concerned.
    if (requestId === null) return 'offline'
  }
  return 'sent'
}

export function sendComposer(
  sender: PaneSender,
  paneId: string,
  text: string,
  mode: ComposerMode,
): SendResult {
  return sendOps(sender, paneId, composerOps(text, mode))
}
