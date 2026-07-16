import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { AGENT_HOOK_TOKEN_PATH_ENV, AgentHookTokenStore } from './agent-hook-token.js'

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'ElicitationResult',
  'Notification',
  'Stop',
  'StopFailure',
  'TaskCreated',
  'TaskCompleted',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
] as const

export const OPENCODE_HOOK_EVENTS = [
  'session.status',
  'session.idle',
  'session.error',
  'session.deleted',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'todo.updated',
  'file.edited',
  'session.diff',
] as const

const CLAUDE_HOOK_MARKER = '--commando-agent-status-hook'
const CLAUDE_BRIDGE_FILENAME = 'commando-claude-agent-status.mjs'
const OPENCODE_PLUGIN_FILENAME = 'commando-agent-status.js'

type JsonObject = Record<string, unknown>

export type AgentHookInstallerOptions = {
  claudeBridgePath?: string
  claudeSettingsPath?: string
  home?: string
  openCodePluginPath?: string
  tokenPath?: string
}

export type AgentHookInstallResult = {
  claudeBridgePath: string
  claudeSettingsPath: string
  openCodePluginPath: string
  tokenPath: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function existingFileMode(path: string, fallback: number): Promise<number> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`${path} must not be a symbolic link`)
    }
    if (!metadata.isFile()) throw new Error(`${path} must be a regular file`)
    return metadata.mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const metadata = await lstat(path)
    if (!metadata.isSymbolicLink() && metadata.isFile()) {
      if ((await readFile(path, 'utf8')) === content) {
        await chmod(path, mode)
        return
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporaryPath, 'wx', mode)
    await handle.writeFile(content, 'utf8')
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporaryPath, path)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function generatedClaudeBridge(tokenPath: string): string {
  return `import { readFile } from 'node:fs/promises'

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function boundedSource(value, maximum) {
  const limit = Math.max(1024, maximum * 4)
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return value.slice(0, half) + '\\n' + value.slice(-half)
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return undefined
  const text = boundedSource(value, maximum)
    .replace(/(\\b[a-z][a-z0-9+.-]*:\\/\\/[^:\\s/@]+:)[^@\\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\\b(?:Bearer|Basic)\\s+[^\\s,;]+/gi, (match) => match.split(/\\s/, 1)[0] + ' [REDACTED]')
    .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\\b/g, '[REDACTED]')
    .replace(/((?:"|')?(?:[A-Za-z0-9]+[_ -])*(?:api[_ -]?(?:key|token|secret)|access[_ -]?token|auth[_ -]?token|token|secret|password)(?:"|')?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n,;]+)/gi, '$1[REDACTED]')
    .replace(/[\\r\\n]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
  return text ? text.slice(0, maximum) : undefined
}

function boundedMessage(value, maximum) {
  if (typeof value !== 'string') return undefined
  const lines = boundedSource(value, maximum)
    .split(/\\r?\\n/)
    .map((line) => boundedText(line, 240))
    .filter(Boolean)
  if (!lines.length) return undefined
  const text = lines.join('\\n')
  if (text.length <= maximum) return text
  const last = lines.at(-1)
  const headLength = Math.max(0, maximum - last.length - 1)
  return (text.slice(0, headLength) + '\\n' + last).slice(0, maximum)
}

function basename(path) {
  return path.split(/[\\\\/]/).filter(Boolean).pop() || path
}

function filePathFrom(args) {
  return boundedText(args.file_path ?? args.filePath ?? args.path, 240)
}

function commandCheck(command, state) {
  if (typeof command !== 'string') return undefined
  const source = command.slice(0, 4000)
  const checks = [
    { pattern: /\\b(?:typecheck|type-check|tsc)\\b/i, label: 'typecheck' },
    { pattern: /\\b(?:test|tests|vitest|jest|pytest|rspec)\\b|\\bgo\\s+test\\b|\\bcargo\\s+test\\b|\\bdotnet\\s+test\\b/i, label: 'tests' },
    { pattern: /\\b(?:build|vite\\s+build|next\\s+build|cargo\\s+build)\\b/i, label: 'build' },
    { pattern: /\\b(?:lint|eslint|stylelint|ruff|clippy)\\b/i, label: 'lint' },
  ]
  const match = checks.find(({ pattern }) => pattern.test(source))
  if (!match) return undefined
  const status = state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'passed'
  return { label: match.label, status }
}

function toolMetadata(toolValue, inputValue, state) {
  const tool = boundedText(toolValue, 80) || 'Tool'
  const lower = tool.toLowerCase()
  const args = asObject(inputValue)
  const filePath = filePathFrom(args)
  let label = tool
  let kind = 'other'
  let check

  if (lower === 'read' || lower.includes('read_file')) {
    label = filePath ? 'Reading ' + basename(filePath) : 'Reading'
    kind = 'inspect'
  } else if (lower === 'grep' || lower === 'glob' || lower.includes('search')) {
    label = 'Searching'
    kind = 'inspect'
  } else if (lower === 'inspect' || lower === 'list' || lower === 'ls' || lower.includes('webfetch')) {
    label = 'Inspecting'
    kind = 'inspect'
  } else if (lower === 'edit' || lower === 'write' || lower.includes('edit_file') || lower.includes('write_file')) {
    label = filePath ? 'Editing ' + basename(filePath) : 'Editing'
    kind = 'edit'
  } else if (lower === 'bash' || lower === 'shell' || lower === 'command') {
    kind = 'command'
    check = commandCheck(args.command, state)
    if (check) {
      label = 'Running ' + check.label
      kind = 'check'
    }
  } else if (lower === 'agent' || lower === 'task' || lower.includes('delegate') || lower.includes('subagent')) {
    const description = boundedText(args.description, 180)
    label = description ? 'Delegating ' + description : 'Delegating'
    kind = 'delegate'
  }

  return {
    activity: { label: boundedText(label, 240) || tool, kind, state },
    check,
    filePath: kind === 'edit' ? filePath : undefined,
  }
}

function questionFrom(args) {
  if (!Array.isArray(args.questions)) return undefined
  const first = asObject(args.questions[0])
  return boundedText(first.question, 200)
}

function attentionFor(input) {
  const event = input.hook_event_name
  const args = asObject(input.tool_input)
  if (event === 'Notification') return boundedText(input.message, 200)
  if (event === 'PermissionRequest') {
    return boundedText(input.message, 200)
      ?? questionFrom(args)
      ?? boundedText(args.description, 200)
  }
  if (event === 'PermissionDenied') return boundedText(input.reason, 200)
  if (event === 'ElicitationResult') return boundedText(input.message ?? input.action, 200)
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') return questionFrom(args)
  return undefined
}

function taskFor(input) {
  if (input.hook_event_name !== 'TaskCreated' && input.hook_event_name !== 'TaskCompleted') {
    return undefined
  }
  const id = boundedText(input.task_id, 120)
  const subject = boundedText(input.task_subject, 240)
  if (!id || !subject) return undefined
  return {
    id,
    subject,
    state: input.hook_event_name === 'TaskCreated' ? 'created' : 'completed',
  }
}

async function main() {
  try {
    const pane = process.env.TMUX_PANE
    if (!pane || !/^%\\d+$/.test(pane)) return
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length < 32) return
    const port = process.env.COMMANDO_PORT || '4310'
    if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    let raw = ''
    for await (const chunk of process.stdin) {
      raw += chunk
      if (raw.length > 2_000_000) return
    }
    const input = JSON.parse(raw)
    const event = input.hook_event_name
    const toolState = event === 'PreToolUse'
      ? 'running'
      : event === 'PostToolUseFailure' ? 'failed' : 'completed'
    const tool = event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure'
      ? toolMetadata(input.tool_name, input.tool_input, toolState)
      : {}
    const subagentActivity = event === 'SubagentStart' || event === 'SubagentStop'
      ? {
          label: 'Subagent ' + (boundedText(input.agent_type, 120) || 'agent'),
          kind: 'delegate',
          state: event === 'SubagentStart' ? 'running' : 'completed',
        }
      : undefined
    const finalMessage = event === 'Stop' || event === 'StopFailure' || event === 'SubagentStop'
      ? boundedMessage(input.last_assistant_message, 2000)
      : undefined
    const error = event === 'PostToolUseFailure' || event === 'StopFailure'
      ? boundedText(input.error_details ?? input.error, 200)
      : undefined
    const body = JSON.stringify({
      hook_event_name: boundedText(event, 80),
      session_id: boundedText(input.session_id, 200),
      tool_name: boundedText(input.tool_name, 80),
      notification_type: boundedText(input.notification_type, 80),
      prompt_id: boundedText(input.prompt_id, 200),
      source: boundedText(input.source, 80),
      intent: event === 'UserPromptSubmit' ? boundedText(input.prompt, 240) : undefined,
      activity: tool.activity ?? subagentActivity,
      activityId: boundedText(input.tool_use_id ?? input.agent_id, 200),
      attention: attentionFor(input),
      task: taskFor(input),
      filePath: tool.filePath,
      check: tool.check,
      finalMessage,
      backgroundTasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : undefined,
      error,
    })
    await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/claude\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body,
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Agent hooks must never interrupt Claude Code when Commando is unavailable.
  }
}

await main()
`
}

function generatedOpenCodePlugin(tokenPath: string): string {
  return `import { readFile } from 'node:fs/promises'

const trackedEvents = new Set(${JSON.stringify(OPENCODE_HOOK_EVENTS)})
let activeSessionId = null
let activeSessionIdle = true
let delivery = Promise.resolve()
const childSessionIds = new Set()
const finalMessages = new Map()
const latestTodos = new Map()
const latestDiffs = new Map()

function asObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function boundedSource(value, maximum) {
  const limit = Math.max(1024, maximum * 4)
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return value.slice(0, half) + '\\n' + value.slice(-half)
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return undefined
  const text = boundedSource(value, maximum)
    .replace(/(\\b[a-z][a-z0-9+.-]*:\\/\\/[^:\\s/@]+:)[^@\\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\\b(?:Bearer|Basic)\\s+[^\\s,;]+/gi, (match) => match.split(/\\s/, 1)[0] + ' [REDACTED]')
    .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\\b/g, '[REDACTED]')
    .replace(/((?:"|')?(?:[A-Za-z0-9]+[_ -])*(?:api[_ -]?(?:key|token|secret)|access[_ -]?token|auth[_ -]?token|token|secret|password)(?:"|')?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n,;]+)/gi, '$1[REDACTED]')
    .replace(/[\\r\\n]+/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
  return text ? text.slice(0, maximum) : undefined
}

function boundedMessage(value, maximum) {
  if (typeof value !== 'string') return undefined
  const lines = boundedSource(value, maximum)
    .split(/\\r?\\n/)
    .map((line) => boundedText(line, 240))
    .filter(Boolean)
  if (!lines.length) return undefined
  const text = lines.join('\\n')
  if (text.length <= maximum) return text
  const last = lines.at(-1)
  const headLength = Math.max(0, maximum - last.length - 1)
  return (text.slice(0, headLength) + '\\n' + last).slice(0, maximum)
}

function basename(path) {
  return path.split(/[\\\\/]/).filter(Boolean).pop() || path
}

function filePathFrom(args) {
  return boundedText(args.file_path ?? args.filePath ?? args.path, 240)
}

function commandCheck(command, state) {
  if (typeof command !== 'string') return undefined
  const source = command.slice(0, 4000)
  const checks = [
    { pattern: /\\b(?:typecheck|type-check|tsc)\\b/i, label: 'typecheck' },
    { pattern: /\\b(?:test|tests|vitest|jest|pytest|rspec)\\b|\\bgo\\s+test\\b|\\bcargo\\s+test\\b|\\bdotnet\\s+test\\b/i, label: 'tests' },
    { pattern: /\\b(?:build|vite\\s+build|next\\s+build|cargo\\s+build)\\b/i, label: 'build' },
    { pattern: /\\b(?:lint|eslint|stylelint|ruff|clippy)\\b/i, label: 'lint' },
  ]
  const match = checks.find(({ pattern }) => pattern.test(source))
  if (!match) return undefined
  const status = state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'passed'
  return { label: match.label, status }
}

function toolMetadata(toolValue, inputValue, state) {
  const tool = boundedText(toolValue, 80) || 'Tool'
  const lower = tool.toLowerCase()
  const args = asObject(inputValue)
  const filePath = filePathFrom(args)
  let label = tool
  let kind = 'other'
  let check

  if (lower === 'read' || lower.includes('read_file')) {
    label = filePath ? 'Reading ' + basename(filePath) : 'Reading'
    kind = 'inspect'
  } else if (lower === 'grep' || lower === 'glob' || lower.includes('search')) {
    label = 'Searching'
    kind = 'inspect'
  } else if (lower === 'inspect' || lower === 'list' || lower === 'ls' || lower.includes('webfetch')) {
    label = 'Inspecting'
    kind = 'inspect'
  } else if (lower === 'edit' || lower === 'write' || lower.includes('edit_file') || lower.includes('write_file')) {
    label = filePath ? 'Editing ' + basename(filePath) : 'Editing'
    kind = 'edit'
  } else if (lower === 'bash' || lower === 'shell' || lower === 'command') {
    kind = 'command'
    check = commandCheck(args.command, state)
    if (check) {
      label = 'Running ' + check.label
      kind = 'check'
    }
  } else if (lower === 'agent' || lower === 'task' || lower.includes('delegate') || lower.includes('subagent')) {
    const description = boundedText(args.description, 180)
    label = description ? 'Delegating ' + description : 'Delegating'
    kind = 'delegate'
  }

  return {
    activity: { label: boundedText(label, 240) || tool, kind, state },
    check,
    filePath: kind === 'edit' ? filePath : undefined,
  }
}

function remember(map, sessionId, value) {
  map.delete(sessionId)
  map.set(sessionId, value)
  if (map.size > 8) map.delete(map.keys().next().value)
}

function observeSession(event) {
  const properties = asObject(event.properties)
  const info = asObject(properties.info)
  const sessionId = boundedText(properties.sessionID ?? info.id, 200)
  if (!sessionId) return false
  if (event.type === 'session.created' || event.type === 'session.updated') {
    if (typeof info.parentID === 'string' && info.parentID) {
      childSessionIds.add(sessionId)
      if (childSessionIds.size > 100) childSessionIds.delete(childSessionIds.values().next().value)
    } else {
      childSessionIds.delete(sessionId)
    }
  }
  const isChild = childSessionIds.has(sessionId)
  if (event.type === 'session.deleted') childSessionIds.delete(sessionId)
  return isChild
}

function tracksActiveSession(event, isChild) {
  const properties = asObject(event.properties)
  const info = asObject(properties.info)
  const sessionId = boundedText(properties.sessionID ?? info.id, 200)
    ?? (event.type === 'file.edited' ? activeSessionId : undefined)
  if (!sessionId || isChild || childSessionIds.has(sessionId)) return undefined
  if (activeSessionId === null || (activeSessionId !== sessionId && activeSessionIdle)) {
    activeSessionId = sessionId
  }
  if (activeSessionId !== sessionId) return undefined

  const statusType = asObject(properties.status).type
  if (event.type === 'session.status' && (statusType === 'busy' || statusType === 'retry')) {
    activeSessionIdle = false
  } else if (event.type === 'session.idle' || statusType === 'idle') {
    activeSessionIdle = true
  } else if (event.type === 'session.deleted') {
    activeSessionId = null
    activeSessionIdle = true
    finalMessages.delete(sessionId)
    latestTodos.delete(sessionId)
    latestDiffs.delete(sessionId)
  }
  return sessionId
}

function acceptsSyntheticSession(sessionIdValue) {
  const sessionId = boundedText(sessionIdValue, 200)
  if (!sessionId || childSessionIds.has(sessionId)) return undefined
  if (activeSessionId === null || (activeSessionId !== sessionId && activeSessionIdle)) {
    activeSessionId = sessionId
  }
  return activeSessionId === sessionId ? sessionId : undefined
}

function sanitizeStatus(value) {
  const status = asObject(value)
  if (status.type !== 'busy' && status.type !== 'idle' && status.type !== 'retry') return undefined
  const result = { type: status.type }
  if (status.type === 'retry') {
    if (Number.isFinite(status.attempt)) result.attempt = status.attempt
    if (Number.isFinite(status.next)) result.next = status.next
    result.message = boundedText(status.message, 200)
  }
  return result
}

function sanitizeTodos(value) {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 20).map((candidate) => {
    const todo = asObject(candidate)
    return {
      content: boundedText(todo.content, 240),
      status: boundedText(todo.status, 40),
      priority: boundedText(todo.priority, 40),
    }
  })
}

function sanitizeDiff(value) {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 20).map((candidate) => {
    const change = asObject(candidate)
    return {
      file: boundedText(change.file, 240),
      additions: Number.isFinite(change.additions) ? Math.max(0, Math.trunc(change.additions)) : 0,
      deletions: Number.isFinite(change.deletions) ? Math.max(0, Math.trunc(change.deletions)) : 0,
    }
  })
}

function errorMessage(value) {
  if (typeof value === 'string') return boundedText(value, 200)
  const error = asObject(value)
  const data = asObject(error.data)
  return boundedText(error.message ?? data.message, 200)
}

function attentionFor(eventType, source) {
  if (eventType === 'permission.asked') {
    return boundedText(source.message ?? source.permission, 200)
  }
  if (eventType === 'question.asked' && Array.isArray(source.questions)) {
    const question = asObject(source.questions[0])
    return boundedText(question.question ?? question.header, 200)
  }
  return undefined
}

function sanitizeProviderEvent(event, sessionId) {
  const source = asObject(event.properties)
  const sourceInfo = asObject(source.info)
  const infoId = boundedText(sourceInfo.id, 200)
  const properties = {
    sessionID: sessionId,
    status: sanitizeStatus(source.status),
    id: boundedText(source.id, 200),
    requestID: boundedText(source.requestID, 200),
    info: infoId ? { id: infoId } : undefined,
    attention: attentionFor(event.type, source),
  }

  if (event.type === 'todo.updated') {
    properties.todos = sanitizeTodos(source.todos)
    if (properties.todos) remember(latestTodos, sessionId, properties.todos)
  } else if (event.type === 'session.diff') {
    properties.diff = sanitizeDiff(source.diff)
    if (properties.diff) remember(latestDiffs, sessionId, properties.diff)
  } else if (event.type === 'file.edited') {
    properties.filePath = boundedText(source.file, 240)
  } else if (event.type === 'session.error') {
    properties.error = errorMessage(source.error)
  }

  const statusType = properties.status?.type
  if (event.type === 'session.idle' || (event.type === 'session.status' && statusType === 'idle')) {
    properties.finalMessage = finalMessages.get(sessionId)
    properties.todos = latestTodos.get(sessionId)
    properties.diff = latestDiffs.get(sessionId)
  }
  return { type: event.type, properties }
}

function intentFromParts(value) {
  if (!Array.isArray(value)) return undefined
  let text = ''
  for (const candidate of value) {
    const part = asObject(candidate)
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    const separator = text ? ' ' : ''
    const remaining = Math.max(0, 480 - text.length - separator.length)
    text += separator + part.text.slice(0, remaining)
    if (text.length >= 480) break
  }
  return boundedText(text, 240)
}

function toolFailed(output) {
  const result = asObject(output)
  const metadata = asObject(result.metadata)
  const exit = metadata.exit ?? metadata.exitCode
  return (typeof exit === 'number' && exit !== 0) || result.error !== undefined
}

async function report(directory, event) {
  try {
    const pane = process.env.TMUX_PANE
    if (!pane || !/^%\\d+$/.test(pane)) return
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length < 32) return
    const port = process.env.COMMANDO_PORT || '4310'
    if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/opencode\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body: JSON.stringify({ directory, event }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Status reporting is best-effort and must not block OpenCode.
  }
}

function enqueue(directory, event) {
  delivery = delivery.then(() => report(directory, event))
  return delivery
}

export const CommandoAgentStatusPlugin = async ({ directory }) => ({
  event: ({ event }) => {
    try {
      const isChild = observeSession(event)
      if (!trackedEvents.has(event.type)) return
      const sessionId = tracksActiveSession(event, isChild)
      if (!sessionId) return
      return enqueue(directory, sanitizeProviderEvent(event, sessionId))
    } catch {
      // Status reporting must never interrupt OpenCode.
    }
  },
  'chat.message': (input, output) => {
    try {
      const sessionId = acceptsSyntheticSession(input.sessionID)
      if (!sessionId) return
      finalMessages.delete(sessionId)
      latestTodos.delete(sessionId)
      latestDiffs.delete(sessionId)
      return enqueue(directory, {
        type: 'commando.turn.started',
        properties: { sessionID: sessionId, intent: intentFromParts(output.parts) },
      })
    } catch {
      // Status reporting must never interrupt OpenCode.
    }
  },
  'tool.execute.before': (input, output) => {
    try {
      const sessionId = acceptsSyntheticSession(input.sessionID)
      if (!sessionId) return
      const metadata = toolMetadata(input.tool, output.args, 'running')
      return enqueue(directory, {
        type: 'commando.activity.started',
        properties: { sessionID: sessionId, activityId: boundedText(input.callID, 200), ...metadata },
      })
    } catch {
      // Status reporting must never interrupt OpenCode.
    }
  },
  'tool.execute.after': (input, output) => {
    try {
      const sessionId = acceptsSyntheticSession(input.sessionID)
      if (!sessionId) return
      const metadata = toolMetadata(input.tool, input.args, toolFailed(output) ? 'failed' : 'completed')
      return enqueue(directory, {
        type: 'commando.activity.completed',
        properties: { sessionID: sessionId, activityId: boundedText(input.callID, 200), ...metadata },
      })
    } catch {
      // Status reporting must never interrupt OpenCode.
    }
  },
  'experimental.text.complete': (input, output) => {
    try {
      const sessionId = boundedText(input.sessionID, 200)
      if (!sessionId || activeSessionId !== sessionId || childSessionIds.has(sessionId)) return
      const finalMessage = boundedMessage(output.text, 2000)
      if (finalMessage) remember(finalMessages, sessionId, finalMessage)
    } catch {
      // Status reporting must never interrupt OpenCode.
    }
  },
})
`
}

function isInstalledClaudeHook(value: unknown, bridgePath: string): boolean {
  if (!isObject(value) || value.type !== 'command' || value.command !== 'node') return false
  if (!Array.isArray(value.args)) return false
  return value.args.includes(CLAUDE_HOOK_MARKER) || value.args[0] === bridgePath
}

function removeInstalledClaudeHooks(entry: unknown, bridgePath: string): unknown | null {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return entry
  const hooks = entry.hooks.filter((hook) => !isInstalledClaudeHook(hook, bridgePath))
  if (hooks.length === entry.hooks.length) return entry
  if (hooks.length === 0 && Object.keys(entry).every((key) => key === 'hooks' || key === 'matcher')) {
    return null
  }
  return { ...entry, hooks }
}

function mergeClaudeHooks(settings: JsonObject, bridgePath: string): JsonObject {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new Error('Claude settings "hooks" must be an object')
  }
  const hooks: JsonObject = settings.hooks ?? {}

  for (const event of CLAUDE_HOOK_EVENTS) {
    const configured = hooks[event]
    if (configured !== undefined && !Array.isArray(configured)) {
      throw new Error(`Claude settings hook "${event}" must be an array`)
    }
    const entries = (configured ?? [])
      .map((entry) => removeInstalledClaudeHooks(entry, bridgePath))
      .filter((entry) => entry !== null)
    entries.push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'node',
        args: [bridgePath, CLAUDE_HOOK_MARKER],
      }],
    })
    hooks[event] = entries
  }

  settings.hooks = hooks
  return settings
}

async function readClaudeSettings(path: string): Promise<{ mode: number; settings: JsonObject }> {
  const mode = await existingFileMode(path, 0o600)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`)
    return { mode, settings: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode, settings: {} }
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${path} contains invalid JSON`, { cause: error })
    }
    throw error
  }
}

export class AgentHookInstaller {
  readonly paths: AgentHookInstallResult

  constructor(options: AgentHookInstallerOptions = {}) {
    const home = options.home ?? process.env.HOME
    if (!home) throw new Error('HOME is required to install agent hooks')
    const resolvedHome = resolve(home)
    const configuredTokenPath = options.tokenPath
      ?? (options.home === undefined ? process.env[AGENT_HOOK_TOKEN_PATH_ENV] : undefined)
    this.paths = {
      tokenPath: resolve(
        configuredTokenPath
          ?? resolve(resolvedHome, '.commando', 'agent-hook-token'),
      ),
      claudeBridgePath: resolve(
        options.claudeBridgePath
          ?? resolve(resolvedHome, '.commando', 'hooks', CLAUDE_BRIDGE_FILENAME),
      ),
      claudeSettingsPath: resolve(
        options.claudeSettingsPath ?? resolve(resolvedHome, '.claude', 'settings.json'),
      ),
      openCodePluginPath: resolve(
        options.openCodePluginPath
          ?? resolve(resolvedHome, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILENAME),
      ),
    }
  }

  async install(): Promise<AgentHookInstallResult> {
    await new AgentHookTokenStore({ path: this.paths.tokenPath }).loadOrCreate()
    await mkdir(dirname(this.paths.claudeBridgePath), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.paths.claudeBridgePath), 0o700)
    await writeAtomically(
      this.paths.claudeBridgePath,
      generatedClaudeBridge(this.paths.tokenPath),
      0o600,
    )
    await writeAtomically(
      this.paths.openCodePluginPath,
      generatedOpenCodePlugin(this.paths.tokenPath),
      0o600,
    )

    const { mode, settings } = await readClaudeSettings(this.paths.claudeSettingsPath)
    const merged = mergeClaudeHooks(settings, this.paths.claudeBridgePath)
    await writeAtomically(
      this.paths.claudeSettingsPath,
      `${JSON.stringify(merged, null, 2)}\n`,
      mode,
    )
    return { ...this.paths }
  }
}

export async function installAgentStatusHooks(
  options: AgentHookInstallerOptions = {},
): Promise<AgentHookInstallResult> {
  return new AgentHookInstaller(options).install()
}
