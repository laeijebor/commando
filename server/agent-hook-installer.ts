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
const SESSION_BRIEF_CLI_FILENAME = 'commando-session-update.mjs'
const PR_MARKER_CLI_FILENAME = 'commando-pr-marker.mjs'

type JsonObject = Record<string, unknown>

export type AgentHookInstallerOptions = {
  claudeBridgePath?: string
  claudeSettingsPath?: string
  home?: string
  openCodePluginPath?: string
  prMarkerCliPath?: string
  sessionBriefCliPath?: string
  tokenPath?: string
}

export type AgentHookInstallResult = {
  claudeBridgePath: string
  claudeSettingsPath: string
  openCodePluginPath: string
  prMarkerCliPath: string
  sessionBriefCliPath: string
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
  return `import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

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
    .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/(\\b[a-z][a-z0-9+.-]*:\\/\\/[^:\\s/@]+:)[^@\\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\\b(?:Bearer|Basic)\\s+[^\\s,;]+/gi, (match) => match.split(/\\s/, 1)[0] + ' [REDACTED]')
    .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\\b/g, '[REDACTED]')
    .replace(/\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/g, '[REDACTED JWT]')
    .replace(/((?:"|')?(?:[A-Za-z0-9]+[_ -])*(?:api[_ -]?(?:key|token|secret)|access[_ -]?(?:key|token)|auth[_ -]?token|secret[_ -]?access[_ -]?key|private[_ -]?key|client[_ -]?secret|token|secret|password|credential)(?:"|')?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n,;]+)/gi, '$1[REDACTED]')
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

function isTaskNotification(value) {
  return typeof value === 'string' && /^\s*<task-notification(?:\s[^>]*)?>/i.test(value)
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

function sanitizedQuestions(value) {
  if (!Array.isArray(value)) return undefined
  const questions = value.slice(0, 8).map((candidate) => {
    const question = asObject(candidate)
    const text = boundedText(question.question, 300)
    if (!text) return undefined
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 12).map((candidateOption) => {
          const option = asObject(candidateOption)
          const label = boundedText(option.label, 80)
          if (!label) return undefined
          return {
            label,
            description: boundedText(option.description, 200),
          }
        }).filter(Boolean)
      : []
    return {
      header: boundedText(question.header, 30) || 'Question',
      question: text,
      options,
      multiple: question.multiSelect === true || question.multiple === true,
      custom: question.custom !== false,
    }
  }).filter(Boolean)
  return questions.length ? questions : undefined
}

function interactionFor(input) {
  if (input.hook_event_name !== 'PermissionRequest') return undefined
  const args = asObject(input.tool_input)
  const questions = input.tool_name === 'AskUserQuestion'
    ? sanitizedQuestions(args.questions)
    : undefined
  const kind = questions ? 'question' : 'permission'
  return {
    id: randomUUID(),
    kind,
    prompt: attentionFor(input) || (kind === 'question' ? questions[0].question : 'Approve this agent action?'),
    toolName: boundedText(input.tool_name, 80),
    questions,
  }
}

function hookOutput(input, request, answer) {
  if (!request || !answer || typeof answer !== 'object') return undefined
  if (request.kind === 'permission') {
    if (answer.action === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Denied from Commando Island' },
        },
      }
    }
    if (answer.action !== 'allow_once' && answer.action !== 'allow_always') return undefined
    const decision = { behavior: 'allow' }
    if (answer.action === 'allow_always' && Array.isArray(input.permission_suggestions)) {
      decision.updatedPermissions = input.permission_suggestions
    }
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }
  }
  if (answer.action === 'reject') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Question dismissed from Commando Island' },
      },
    }
  }
  if (answer.action !== 'answer' || !Array.isArray(answer.answers)) return undefined
  const args = asObject(input.tool_input)
  const originalQuestions = Array.isArray(args.questions) ? args.questions : []
  if (answer.answers.length !== originalQuestions.length) return undefined
  const answers = {}
  for (const [index, candidate] of originalQuestions.entries()) {
    const question = asObject(candidate)
    if (typeof question.question !== 'string' || !Array.isArray(answer.answers[index])) return undefined
    answers[question.question] = answer.answers[index].join(', ')
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        updatedInput: { ...args, answers },
      },
    },
  }
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

function taskStatus(value) {
  if (value === 'deleted') return 'cancelled'
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
    ? value
    : undefined
}

function sanitizedTask(value) {
  const task = asObject(value)
  const content = boundedText(task.subject ?? task.content, 240)
  const status = taskStatus(task.status)
  if (!content || !status) return undefined
  return {
    id: boundedText(task.id ?? task.taskId, 120),
    content,
    status,
    priority: task.priority === 'high' || task.priority === 'low' ? task.priority : 'medium',
    createdAt: Number.isSafeInteger(task.createdAt) && task.createdAt >= 0 ? task.createdAt : undefined,
    updatedAt: Number.isSafeInteger(task.updatedAt) && task.updatedAt >= 0 ? task.updatedAt : undefined,
  }
}

function sanitizeTaskList(value) {
  if (!Array.isArray(value)) return undefined
  const tasks = value.map(sanitizedTask).filter(Boolean)
  return tasks.length || value.length === 0 ? tasks : undefined
}

function planUpdateFor(input) {
  if (input.hook_event_name !== 'PostToolUse') return {}
  const tool = boundedText(input.tool_name, 80)?.toLowerCase()
  const args = asObject(input.tool_input)
  const response = asObject(input.tool_response ?? input.tool_result)
  const data = asObject(response.data)
  if (tool === 'todowrite') {
    const tasks = sanitizeTaskList(args.todos)
    return tasks ? { taskSnapshot: tasks } : {}
  }
  if (tool === 'tasklist') {
    const source = Array.isArray(response.tasks) ? response.tasks : Array.isArray(data.tasks) ? data.tasks : undefined
    const tasks = sanitizeTaskList(source)
    return tasks ? { taskSnapshot: tasks } : {}
  }
  if (tool === 'taskcreate') {
    const task = asObject(response.task ?? data.task)
    const id = boundedText(task.id ?? response.taskId ?? data.taskId, 120)
    const content = boundedText(task.subject ?? args.subject, 240)
    return id && content ? { taskPatch: { id, content, status: 'pending' } } : {}
  }
  if (tool === 'taskupdate') {
    const id = boundedText(args.taskId ?? response.taskId ?? data.taskId, 120)
    const status = taskStatus(args.status)
    const content = boundedText(args.subject, 240)
    return id && (status || content) ? { taskPatch: { id, content, status } } : {}
  }
  return {}
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
    if (event === 'UserPromptSubmit' && isTaskNotification(input.prompt)) return
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
    const request = interactionFor(input)
    const planUpdate = planUpdateFor(input)
    const body = JSON.stringify({
      hook_event_name: boundedText(event, 80),
      session_id: boundedText(input.session_id, 200),
      session_title: boundedText(input.session_title, 120),
      tool_name: boundedText(input.tool_name, 80),
      notification_type: boundedText(input.notification_type, 80),
      prompt_id: boundedText(input.prompt_id, 200),
      source: boundedText(input.source, 80),
      intent: event === 'UserPromptSubmit' ? boundedText(input.prompt, 240) : undefined,
      activity: tool.activity ?? subagentActivity,
      activityId: boundedText(input.tool_use_id ?? input.agent_id, 200),
      attention: attentionFor(input),
      request,
      task: taskFor(input),
      taskPatch: planUpdate.taskPatch,
      taskSnapshot: planUpdate.taskSnapshot,
      filePath: tool.filePath,
      check: tool.check,
      finalMessage,
      backgroundTasks: Array.isArray(input.background_tasks) ? input.background_tasks.length : undefined,
      error,
    })
    const response = await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/claude\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body,
      signal: AbortSignal.timeout(request ? 590000 : 1000),
    })
    if (!request || !response.ok) return
    const result = await response.json()
    const output = hookOutput(input, request, asObject(result).answer)
    if (output) process.stdout.write(JSON.stringify(output))
  } catch {
    // Agent hooks must never interrupt Claude Code when Commando is unavailable.
  }
}

await main()
`
}

function generatedSessionBriefCli(tokenPath: string): string {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const tokenPath = ${JSON.stringify(tokenPath)}
const args = process.argv.slice(2)

function usage() {
  console.error('Usage: commando-session-update [--headline text] [--recap-markdown text] [--next text|--clear-next] [--state status] [--update kind text] [--detail text] [--screenshots dir] [--stdin]')
}

async function stdinJson() {
  let content = ''
  for await (const chunk of process.stdin) {
    content += chunk
    if (content.length > 16 * 1024) throw new Error('stdin payload is too large')
  }
  const parsed = JSON.parse(content)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdin payload must be a JSON object')
  }
  return parsed
}

function valueAfter(index, flag) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value')
  return value
}

async function bodyFromArgs() {
  if (args.includes('--stdin')) return stdinJson()
  const body = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--headline') body.headline = valueAfter(index++, flag)
    else if (flag === '--recap-markdown') body.recapMarkdown = valueAfter(index++, flag)
    else if (flag === '--next') body.next = valueAfter(index++, flag)
    else if (flag === '--clear-next') body.next = null
    else if (flag === '--state') body.state = valueAfter(index++, flag)
    else if (flag === '--screenshots') body.screenshots = { dir: resolve(valueAfter(index++, flag)) }
    else if (flag === '--update') {
      const kind = valueAfter(index, flag)
      const text = args[index + 2]
      if (!text || text.startsWith('--')) throw new Error('--update requires a kind and text')
      body.update = { kind, text }
      index += 2
    } else if (flag === '--detail') {
      if (!body.update) throw new Error('--detail requires --update')
      body.update.detail = valueAfter(index++, flag)
    } else {
      throw new Error('Unknown argument: ' + flag)
    }
  }
  return body
}

try {
  const paneId = process.env.TMUX_PANE
  if (!/^%\\d+$/.test(paneId ?? '')) throw new Error('TMUX_PANE must identify the current pane')
  const port = Number.parseInt(process.env.COMMANDO_PORT ?? '4310', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COMMANDO_PORT is invalid')
  const body = await bodyFromArgs()
  if (Object.keys(body).length === 0) {
    usage()
    process.exitCode = 2
  } else {
    const token = (await readFile(tokenPath, 'utf8')).trim()
    const response = await fetch('http://127.0.0.1:' + port + '/api/session-brief', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Commando-Pane': paneId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error ?? ('Commando returned ' + response.status))
    console.log(JSON.stringify(result.brief))
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  usage()
  process.exitCode = 1
}
`
}

function generatedPrMarkerCli(tokenPath: string): string {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

const tokenPath = ${JSON.stringify(tokenPath)}

try {
  const paneId = process.env.TMUX_PANE
  if (!/^%\\d+$/.test(paneId ?? '')) throw new Error('TMUX_PANE must identify the current pane')
  const port = Number.parseInt(process.env.COMMANDO_PORT ?? '4310', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COMMANDO_PORT is invalid')
  const token = (await readFile(tokenPath, 'utf8')).trim()
  const response = await fetch('http://127.0.0.1:' + port + '/api/pane-target-marker', {
    headers: {
      Authorization: 'Bearer ' + token,
      'X-Commando-Pane': paneId,
    },
    signal: AbortSignal.timeout(3_000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error ?? ('Commando returned ' + response.status))
  if (typeof result.marker !== 'string' || !/^<!-- commando:v1 target=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12} relation=created -->$/.test(result.marker)) {
    throw new Error('Commando returned an invalid PR marker')
  }
  process.stdout.write(result.marker + '\\n')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
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
const sessionNames = new Map()

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
    .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)/gi, '[REDACTED PRIVATE KEY]')
    .replace(/(\\b[a-z][a-z0-9+.-]*:\\/\\/[^:\\s/@]+:)[^@\\s/]+@/gi, '$1[REDACTED]@')
    .replace(/\\b(?:Bearer|Basic)\\s+[^\\s,;]+/gi, (match) => match.split(/\\s/, 1)[0] + ' [REDACTED]')
    .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16})\\b/g, '[REDACTED]')
    .replace(/\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/g, '[REDACTED JWT]')
    .replace(/((?:"|')?(?:[A-Za-z0-9]+[_ -])*(?:api[_ -]?(?:key|token|secret)|access[_ -]?(?:key|token)|auth[_ -]?token|secret[_ -]?access[_ -]?key|private[_ -]?key|client[_ -]?secret|token|secret|password|credential)(?:"|')?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\r\\n,;]+)/gi, '$1[REDACTED]')
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
    const sessionName = boundedText(info.title, 120)
    if (sessionName) remember(sessionNames, sessionId, sessionName)
    if (typeof info.parentID === 'string' && info.parentID) {
      childSessionIds.add(sessionId)
      if (childSessionIds.size > 100) childSessionIds.delete(childSessionIds.values().next().value)
    } else {
      childSessionIds.delete(sessionId)
    }
  }
  const isChild = childSessionIds.has(sessionId)
  if (event.type === 'session.deleted') childSessionIds.delete(sessionId)
  if (event.type === 'session.deleted') sessionNames.delete(sessionId)
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
      id: boundedText(todo.id, 120),
      content: boundedText(todo.content, 240),
      status: boundedText(todo.status, 40),
      priority: boundedText(todo.priority, 40),
      createdAt: Number.isSafeInteger(todo.createdAt) && todo.createdAt >= 0 ? todo.createdAt : undefined,
      updatedAt: Number.isSafeInteger(todo.updatedAt) && todo.updatedAt >= 0 ? todo.updatedAt : undefined,
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

function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return undefined
  const questions = value.slice(0, 8).map((candidate) => {
    const question = asObject(candidate)
    const text = boundedText(question.question, 300)
    if (!text) return undefined
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 12).map((candidateOption) => {
          const option = asObject(candidateOption)
          const label = boundedText(option.label, 80)
          if (!label) return undefined
          return {
            label,
            description: boundedText(option.description, 200),
          }
        }).filter(Boolean)
      : []
    return {
      header: boundedText(question.header, 30) || 'Question',
      question: text,
      options,
      multiple: question.multiple === true || question.multiSelect === true,
      custom: question.custom !== false,
    }
  }).filter(Boolean)
  return questions.length ? questions : undefined
}

function interactionFor(eventType, source) {
  const id = boundedText(source.id, 200)
  if (!id) return undefined
  if (eventType === 'permission.asked') {
    const prompt = attentionFor(eventType, source) || 'Approve this agent action?'
    return {
      id,
      kind: 'permission',
      prompt,
      toolName: boundedText(source.permission, 80),
    }
  }
  if (eventType === 'question.asked') {
    const questions = sanitizeQuestions(source.questions)
    if (!questions) return undefined
    return {
      id,
      kind: 'question',
      prompt: questions[0].question,
      questions,
    }
  }
  return undefined
}

function sanitizeProviderEvent(event, sessionId) {
  const source = asObject(event.properties)
  const sourceInfo = asObject(source.info)
  const infoId = boundedText(sourceInfo.id, 200)
  const properties = {
    sessionID: sessionId,
    sessionName: sessionNames.get(sessionId),
    status: sanitizeStatus(source.status),
    id: boundedText(source.id, 200),
    requestID: boundedText(source.requestID, 200),
    info: infoId ? { id: infoId } : undefined,
    attention: attentionFor(event.type, source),
    request: interactionFor(event.type, source),
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
  const hasExit = Object.prototype.hasOwnProperty.call(metadata, 'exit') ||
    Object.prototype.hasOwnProperty.call(metadata, 'exitCode')
  const exit = Object.prototype.hasOwnProperty.call(metadata, 'exit')
    ? metadata.exit
    : metadata.exitCode
  return (hasExit && exit !== 0) ||
    metadata.timedOut === true ||
    metadata.aborted === true ||
    result.error !== undefined
}

async function report(directory, event, onStarted) {
  let started = false
  const markStarted = () => {
    if (started) return
    started = true
    onStarted?.()
  }
  try {
    const pane = process.env.TMUX_PANE
    if (!pane || !/^%\\d+$/.test(pane)) return
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length < 32) return
    const port = process.env.COMMANDO_PORT || '4310'
    if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    const interactive = event.type === 'permission.asked' || event.type === 'question.asked'
    const responsePending = fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/opencode\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body: JSON.stringify({ directory, event }),
      signal: AbortSignal.timeout(interactive ? 590000 : 1000),
    })
    markStarted()
    const response = await responsePending
    if (!interactive || !response.ok) return undefined
    return asObject(await response.json()).answer
  } catch {
    // Status reporting is best-effort and must not block OpenCode.
  } finally {
    markStarted()
  }
}

function enqueue(directory, event) {
  delivery = delivery.catch(() => undefined).then(() => report(directory, event))
  return delivery
}

async function answerInteraction(directory, event, client, onStarted) {
  const answer = asObject(await report(directory, event, onStarted))
  const properties = asObject(event.properties)
  const requestID = boundedText(properties.id, 200)
  if (!requestID || !client) return
  if (event.type === 'permission.asked') {
    const replies = { allow_once: 'once', allow_always: 'always', deny: 'reject' }
    const reply = replies[answer.action]
    if (!reply || typeof client.permission?.reply !== 'function') return
    await client.permission.reply({ requestID, directory, reply })
    return
  }
  if (event.type !== 'question.asked') return
  if (answer.action === 'reject') {
    if (typeof client.question?.reject === 'function') {
      await client.question.reject({ requestID, directory })
    }
    return
  }
  if (
    answer.action === 'answer' &&
    Array.isArray(answer.answers) &&
    typeof client.question?.reply === 'function'
  ) {
    await client.question.reply({ requestID, directory, answers: answer.answers })
  }
}

function enqueueInteraction(directory, event, client) {
  let interaction
  const started = delivery.catch(() => undefined).then(() => new Promise((resolve) => {
    interaction = answerInteraction(directory, event, client, resolve)
  }))
  delivery = started
  return started.then(() => interaction)
}

export const CommandoAgentStatusPlugin = async ({ directory, client }) => ({
  event: ({ event }) => {
    try {
      const isChild = observeSession(event)
      if (!trackedEvents.has(event.type)) return
      const sessionId = tracksActiveSession(event, isChild)
      if (!sessionId) return
      const sanitized = sanitizeProviderEvent(event, sessionId)
      if (event.type === 'permission.asked' || event.type === 'question.asked') {
        return enqueueInteraction(directory, sanitized, client)
      }
      return enqueue(directory, sanitized)
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
    const configuredClaudeDirectory = options.home === undefined
      ? process.env.CLAUDE_CONFIG_DIR
      : undefined
    if (configuredClaudeDirectory !== undefined && configuredClaudeDirectory.trim().length === 0) {
      throw new Error('CLAUDE_CONFIG_DIR must not be empty')
    }
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
        options.claudeSettingsPath
          ?? (configuredClaudeDirectory
            ? resolve(configuredClaudeDirectory, 'settings.json')
            : resolve(resolvedHome, '.claude', 'settings.json')),
      ),
      openCodePluginPath: resolve(
        options.openCodePluginPath
          ?? resolve(resolvedHome, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILENAME),
      ),
      prMarkerCliPath: resolve(
        options.prMarkerCliPath
          ?? resolve(resolvedHome, '.commando', 'hooks', PR_MARKER_CLI_FILENAME),
      ),
      sessionBriefCliPath: resolve(
        options.sessionBriefCliPath
          ?? resolve(resolvedHome, '.commando', 'hooks', SESSION_BRIEF_CLI_FILENAME),
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
    await writeAtomically(
      this.paths.sessionBriefCliPath,
      generatedSessionBriefCli(this.paths.tokenPath),
      0o700,
    )
    await writeAtomically(
      this.paths.prMarkerCliPath,
      generatedPrMarkerCli(this.paths.tokenPath),
      0o700,
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
