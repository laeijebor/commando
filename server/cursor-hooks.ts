import { createHash } from 'node:crypto'
import { discoverCursorAssociation } from './cursor-hook-ownership.js'

/** Cursor's native hook names; do not register thought/transcript telemetry. */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'afterFileEdit', 'afterAgentResponse', 'stop',
  'sessionEnd', 'subagentStart', 'subagentStop',
] as const

export function isCursorInvocation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return typeof input.cursor_version === 'string' && input.cursor_version.length > 0 &&
    typeof input.conversation_id === 'string' && input.conversation_id.length > 0
}

/** Opaque native IDs are correlation keys, never user-visible/raw telemetry. */
export function sanitizeCursorActivityId(value: unknown): string | undefined {
  return cursorActivityId(value, createHash)
}

// The emitted function receives crypto explicitly, avoiding compiler import aliases.
function cursorActivityId(value: unknown, hash: typeof createHash): string | undefined {
  if (!(typeof value === 'string' && value !== '' || typeof value === 'number' && Number.isSafeInteger(value))) return undefined
  // JSON preserves control characters and lone surrogates without UTF-8 replacement collisions.
  const encoded = JSON.stringify([typeof value, value])
  if (Buffer.byteLength(encoded, 'utf8') > 1_024) return undefined
  return 'cursor-tool:' + hash('sha256').update(encoded).digest('hex')
}

/** Embedded with the activity-ID helper, without installed worktree imports. */
export function normalizeCursorHook(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.is_background_agent !== undefined && input.is_background_agent !== false) return null
  const text = (value: unknown, maximum: number, preserveLines = false): string | undefined => {
    if (typeof value !== 'string') return undefined
    // Redact before truncation, including multiline private keys and fenced contents.
    const result = value.slice(0, 2_000_000)
      .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
      .replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]+)\b/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
      .replace(/((?:"|')?(?:[A-Za-z0-9]+[_ -])*(?:api[_ -]?(?:key|token|secret)|access[_ -]?(?:key|token)|auth[_ -]?token|secret[_ -]?access[_ -]?key|private[_ -]?key|client[_ -]?secret|token|secret|password|passwd|credential|authorization)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(preserveLines ? /[ \t]+/g : /\s+/g, ' ').trim()
    return result ? result.slice(0, maximum) : undefined
  }
  const identifier = (value: unknown): string | undefined =>
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ? value : undefined
  const event = input.hook_event_name
  if (typeof event !== 'string' || ![
    'sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
    'postToolUseFailure', 'afterFileEdit', 'afterAgentResponse', 'stop',
    'sessionEnd', 'subagentStart', 'subagentStop',
  ].includes(event)) return null
  const conversation = identifier(input.conversation_id)
  const generation = identifier(input.generation_id)
  if (!conversation || (!generation && event !== 'sessionStart' && event !== 'sessionEnd')) return null
  const parent = identifier(input.parent_conversation_id)
  const child = identifier(input.subagent_id)
  if ((input.parent_conversation_id !== undefined && !parent) ||
    (input.subagent_id !== undefined && !child)) return null
  if ((event === 'subagentStart' || event === 'subagentStop') && !child) return null
  // Child conversation telemetry cannot own the pane's parent turn.
  if (parent && parent !== conversation && event !== 'subagentStart' && event !== 'subagentStop') return null
  const result: Record<string, unknown> = {
    hook_event_name: event, conversation_id: conversation,
    ...(generation ? { generation_id: generation } : {}),
    ...(parent ? { parent_conversation_id: parent } : {}),
    ...(child ? { subagent_id: child } : {}),
  }
  if (event === 'stop') {
    if (!['completed', 'error', 'aborted'].includes(input.status as string)) return null
    result.status = input.status
  }
  if (event === 'beforeSubmitPrompt') result.intent = text(input.prompt ?? input.intent, 240)
  if (event === 'afterAgentResponse') {
    // Prefer the final explicit recap convention; redact it before transmitting.
    const message = input.text ?? input.finalMessage
    if (typeof message === 'string') {
      const redacted = text(message, 2_000_000, true)
      const lines = (redacted ?? '').split(/\r?\n/)
      const recapLine = lines.filter((line) => /^\s*[🟢🟡🔴]/u.test(line)).at(-1)
      const firstLine = text(recapLine ?? lines.find((line) => line.trim()), 180)
      result.finalMessage = redacted?.includes('[REDACTED PRIVATE KEY]') ? 'Cursor response received' : firstLine
    }
  }
  if (event === 'sessionEnd') result.reason = ['completed', 'aborted', 'error', 'window_close', 'user_close'].includes(input.reason as string) ? input.reason : undefined
  if (event === 'afterFileEdit') result.filePath = text(input.file_path ?? input.filePath, 240)
  if (event === 'preToolUse' || event === 'postToolUse' || event === 'postToolUseFailure') {
    const name = typeof input.tool_name === 'string' ? input.tool_name : ''
    const tools: Record<string, { label: string; kind: string }> = {
      Read: { label: 'Read file', kind: 'inspect' }, Grep: { label: 'Search files', kind: 'inspect' },
      Glob: { label: 'Find files', kind: 'inspect' }, Write: { label: 'Write file', kind: 'edit' },
      Delete: { label: 'Delete file', kind: 'edit' }, Shell: { label: 'Run command', kind: 'command' },
      Task: { label: 'Delegate task', kind: 'delegate' },
    }
    const tool = tools[name] ?? { label: name.startsWith('MCP:') ? 'Call MCP tool' : 'Use tool', kind: 'other' }
    const activity = typeof input.activity === 'object' && input.activity !== null ? input.activity as Record<string, unknown> : {}
    const known = [...Object.values(tools), { label: 'Call MCP tool', kind: 'other' }, { label: 'Use tool', kind: 'other' }].find((candidate) => candidate.label === activity.label && candidate.kind === activity.kind)
    result.activity = { ...(known ?? tool), state: event === 'preToolUse' ? 'running' : event === 'postToolUseFailure' ? 'failed' : 'completed' }
    result.activityId = input.tool_use_id !== undefined ? sanitizeCursorActivityId(input.tool_use_id) :
      typeof input.activityId === 'string' && /^cursor-tool:[a-f0-9]{64}$/.test(input.activityId)
        ? input.activityId : sanitizeCursorActivityId(input.activityId)
    const args = typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input as Record<string, unknown> : {}
    // Only recognized check names and the numeric exit code are retained from Shell.
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    const match = /^(?:npm|pnpm|yarn|bun) (?:run )?(test|typecheck|lint|build)(?:\s+[-\w.=]+)*$/.exec(command)
    if (name === 'Shell' && match) {
      let exitCode: unknown
      if (event === 'postToolUse' && typeof input.tool_output === 'string') {
        try { exitCode = (JSON.parse(input.tool_output) as Record<string, unknown>)?.exitCode } catch { /* no invented result */ }
      }
      const status = event === 'preToolUse' ? 'running' : event === 'postToolUseFailure' ? 'failed' :
        typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode === 0 ? 'passed' : 'failed' : undefined
      if (status) result.check = { label: match[1], status }
    } else if (typeof input.check === 'object' && input.check !== null) {
      const check = input.check as Record<string, unknown>
      if (['test', 'typecheck', 'lint', 'build'].includes(check.label as string) && ['running', 'passed', 'failed'].includes(check.status as string)) result.check = { label: check.label, status: check.status }
    }
  }
  if (event === 'subagentStart' || event === 'subagentStop') {
    if (event === 'subagentStop' && ['completed', 'error', 'aborted'].includes(input.status as string)) result.status = input.status
    result.activityId = child
    result.activity = { label: 'Subagent', kind: 'delegate', state: event === 'subagentStart' ? 'running' : input.status === 'error' || input.status === 'aborted' ? 'failed' : 'completed' }
  }
  return result
}

export function generatedCursorBridge(tokenPath: string, instructions: string): string {
  return `import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, join } from 'node:path'
// esbuild/tsx keepNames wraps nested functions in this helper.
const __name = (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true })
${cursorActivityId.toString()}
function sanitizeCursorActivityId(value) { return cursorActivityId(value, createHash) }
${normalizeCursorHook.toString()}
${discoverCursorAssociation.toString()}
const emittedAt = process.hrtime.bigint().toString()
const execute = promisify(execFile)
const io = {
  run: async (command, args) => (await execute(command, args, { timeout: 750, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })).stdout,
  socket: async (path) => {
    const resolved = await realpath(path)
    const metadata = await stat(resolved, { bigint: true })
    return metadata.isSocket() ? { path: resolved, device: String(metadata.dev), inode: String(metadata.ino) } : null
  },
  executable: async (command) => {
    for (const path of command.includes('/') ? [command] : (process.env.PATH || '').split(delimiter).map((directory) => join(directory, command))) {
      try { return await realpath(path) } catch { /* next executable */ }
    }
    return null
  },
}
const configuredEvent = process.argv[3]
let output = configuredEvent === 'preToolUse' || configuredEvent === 'subagentStart' ? { permission: 'allow' }
  : configuredEvent === 'beforeSubmitPrompt' ? { continue: true } : {}
try {
  let raw = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 8 * 1024 * 1024) throw new Error('oversized input')
    raw += chunk
  }
  const input = JSON.parse(raw)
  const event = input.hook_event_name
  if (event === 'preToolUse' || event === 'subagentStart') output = { permission: 'allow' }
  if (event === 'beforeSubmitPrompt') output = { continue: true }
  const body = normalizeCursorHook(input)
  const pane = process.env.TMUX_PANE
  const port = process.env.COMMANDO_PORT || '4310'
  const tmux = /^(.*),(\\d+),(\\d+)$/.exec(process.env.TMUX || '')
  if (body && /^%\\d+$/.test(pane || '') && tmux && /^\\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535) {
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length >= 32) {
      const association = await discoverCursorAssociation(pane, ['-S', tmux[1]], process.pid, null, io)
      if (association && association.serverPid === Number(tmux[2])) {
        body.association = association
        body.emittedAt = emittedAt
        const encoded = JSON.stringify(body)
        if (Buffer.byteLength(encoded) <= 64 * 1024) {
          const response = await fetch('http://127.0.0.1:' + port + '/api/agent-status/hooks/cursor', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Commando-Pane': pane },
            body: encoded, signal: AbortSignal.timeout(3000),
          })
          const accepted = response.ok && (await response.json()).accepted === true
          if (accepted && event === 'sessionStart' && !input.parent_conversation_id && !input.subagent_id) {
            const id = input.conversation_id
            const resume = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(id) ? '\\nResume command for this conversation: agent --resume=' + id + ' (pin it once with the --session flag)' : ''
            output = { additional_context: ${JSON.stringify(instructions)} + resume }
          }
        }
      }
    }
  }
} catch { /* Hooks must leave Cursor usable when Commando is unavailable. */ }
process.stdout.write(JSON.stringify(output) + '\\n')
`
}
