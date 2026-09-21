import { randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
const CODEX_BRIDGE_FILENAME = 'commando-codex-notify.mjs'
const SESSION_BRIEF_CLI_FILENAME = 'commando-session-update.mjs'
const PR_MARKER_CLI_FILENAME = 'commando-pr-marker.mjs'

type JsonObject = Record<string, unknown>

export type AgentHookInstallerOptions = {
  claudeBridgePath?: string
  claudeSettingsPath?: string
  codexBridgePath?: string
  codexConfigPath?: string
  home?: string
  openCodePluginPath?: string
  prMarkerCliPath?: string
  sessionBriefCliPath?: string
  tokenPath?: string
}

export type AgentHookRepairResult = {
  repaired: boolean
  staleBridgePaths: string[]
}

export type AgentHookInstallResult = {
  claudeBridgePath: string
  claudeSettingsPath: string
  codexBridgePath: string
  codexConfigPath: string
  codexNotifyWarning?: string
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

function agentIntegrationInstructions(prMarkerCliPath: string, sessionBriefCliPath: string): string {
  return [
    'Commando pane integration (this agent runs inside a tmux pane):',
    `When the user asks you to create a pull request, first run node ${JSON.stringify(prMarkerCliPath)} in this pane. Append its exact HTML comment to the PR body before creating the PR, including when using gh pr create or a GitHub MCP tool.`,
    'Preserve existing Commando markers when editing PR bodies. Never invent a target UUID or claim a PR created in another pane. If marker lookup fails, report that linkage is unavailable instead of silently omitting it.',
    `Keep your task list current. Publish meaningful handoffs and screenshot folders with node ${JSON.stringify(sessionBriefCliPath)} (use --headline, --update, or --screenshots /absolute/path).`,
    'These instructions do not authorize creating or editing a PR unless requested by the user.',
  ].join('\n')
}

function generatedClaudeBridge(tokenPath: string, instructions: string): string {
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
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: event, additionalContext: ${JSON.stringify(instructions)},
      } }) + '\\n')
    }
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

function generatedCodexBridge(tokenPath: string, forwardTo: readonly string[] | null): string {
  return `import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

// Codex CLI spawns this program once per turn with a single JSON argument.
// Anything the user configured before Commando is chained with the same
// argument so installing the bridge never silences an existing notifier.
const forwardTo = ${JSON.stringify(forwardTo ?? null)}

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

function firstText(payload, names, maximum) {
  for (const name of names) {
    const text = boundedText(payload[name], maximum)
    if (text) return text
  }
  return undefined
}

function inputMessages(value) {
  if (!Array.isArray(value)) return undefined
  const messages = value.slice(0, 8).map((entry) => boundedText(entry, 240)).filter(Boolean)
  return messages.length ? messages : undefined
}

function forwardPreviousNotifier(argument) {
  if (!Array.isArray(forwardTo) || forwardTo.length === 0) return
  try {
    const child = spawn(
      forwardTo[0],
      [...forwardTo.slice(1), ...(typeof argument === 'string' ? [argument] : [])],
      { detached: true, stdio: 'ignore' },
    )
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // A broken previous notifier must not break Codex either.
  }
}

async function main() {
  const argument = process.argv[2]
  forwardPreviousNotifier(argument)
  try {
    if (typeof argument !== 'string' || argument.length > 1_000_000) return
    let payload
    try {
      payload = JSON.parse(argument)
    } catch {
      return
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return
    const type = boundedText(payload.type, 80)
    if (!type) return
    const pane = process.env.TMUX_PANE
    if (!pane || !/^%\\d+$/.test(pane)) return
    const token = (await readFile(${JSON.stringify(tokenPath)}, 'utf8')).trim()
    if (token.length < 32) return
    const port = process.env.COMMANDO_PORT || '4310'
    if (!/^\\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return
    const event = {
      type,
      'turn-id': firstText(payload, ['turn-id', 'turn_id', 'turnId'], 200),
      'thread-id': firstText(payload, ['thread-id', 'thread_id', 'threadId', 'session-id', 'session_id', 'sessionId'], 200),
      cwd: boundedText(payload.cwd, 240),
      client: boundedText(payload.client, 80),
      'input-messages': inputMessages(payload['input-messages'] ?? payload.input_messages),
      'last-assistant-message': boundedMessage(
        payload['last-assistant-message'] ?? payload.last_assistant_message,
        2000,
      ),
    }
    await fetch(\`http://127.0.0.1:\${port}/api/agent-status/hooks/codex\`, {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${token}\`,
        'Content-Type': 'application/json',
        'X-Commando-Pane': pane,
      },
      body: JSON.stringify({ event, receivedAt: Date.now() }),
      signal: AbortSignal.timeout(1000),
    })
  } catch {
    // Lifecycle callbacks must never interrupt Codex when Commando is unavailable.
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

function generatedOpenCodePlugin(tokenPath: string, instructions: string): string {
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
  'experimental.chat.system.transform': async (_input, output) => {
    if (!/^%\\d+$/.test(process.env.TMUX_PANE ?? '')) return
    const instructions = ${JSON.stringify(instructions)}
    if (!output.system.includes(instructions)) output.system.push(instructions)
  },
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

// Codex has no JSON config and Commando ships no TOML parser, so the `notify`
// key is merged by line surgery: only the managed block is ever rewritten, every
// other line keeps its exact text and position, and the block records any
// notifier it wrapped so reruns stay idempotent.
const CODEX_NOTIFY_MARKER = '# commando:codex-notify v1'
const CODEX_NOTIFY_MARKER_LINE = /^[ \t]*# commando:codex-notify v1(?:[ \t]+wrapped=(.*?))?[ \t]*$/
const CODEX_NOTIFY_KEY = /^[ \t]*(?:notify|"notify"|'notify')[ \t]*=/

type TomlScanState = { multiline: string | null; depth: number }

type CodexNotifySpan = {
  start: number
  end: number
  value: string
}

export type CodexNotifyMerge = {
  content: string
  changed: boolean
  forwardTo: string[] | null
  warning: string | null
}

function skipTomlString(line: string, index: number, quote: string): number {
  let cursor = index + 1
  while (cursor < line.length) {
    if (quote === '"' && line[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (line[cursor] === quote) return cursor + 1
    cursor += 1
  }
  return line.length
}

function consumeTomlLine(line: string, state: TomlScanState): TomlScanState {
  let { multiline, depth } = state
  let cursor = 0
  while (cursor < line.length) {
    if (multiline !== null) {
      const close = line.indexOf(multiline, cursor)
      if (close === -1) return { multiline, depth }
      cursor = close + multiline.length
      multiline = null
      continue
    }
    if (line.startsWith('"""', cursor) || line.startsWith("'''", cursor)) {
      multiline = line.slice(cursor, cursor + 3)
      cursor += 3
      continue
    }
    const character = line[cursor]
    if (character === '#') return { multiline, depth }
    if (character === '"' || character === "'") {
      cursor = skipTomlString(line, cursor, character)
      continue
    }
    if (character === '[') depth += 1
    else if (character === ']') depth = Math.max(0, depth - 1)
    cursor += 1
  }
  return { multiline, depth }
}

// Scans the document's top-level region (everything before the first table
// header) for a `notify` assignment, following its value across continuation
// lines. A `notify` inside a table is deliberately invisible here.
function scanTopLevelNotify(lines: string[]): {
  end: number
  notify: CodexNotifySpan | null
  unterminated: boolean
} {
  let state: TomlScanState = { multiline: null, depth: 0 }
  let notify: CodexNotifySpan | null = null
  let start: number | null = null
  let end = lines.length
  for (const [index, line] of lines.entries()) {
    if (state.multiline === null && state.depth === 0) {
      if (line.trim().startsWith('[')) {
        end = index
        break
      }
      if (notify === null && start === null && CODEX_NOTIFY_KEY.test(line)) start = index
    }
    state = consumeTomlLine(line, state)
    if (start !== null && state.multiline === null && state.depth === 0) {
      const text = lines.slice(start, index + 1).join('\n')
      notify = { start, end: index, value: text.slice(text.indexOf('=') + 1) }
      start = null
    }
  }
  return { end, notify, unterminated: start !== null }
}

function unescapeTomlBasicString(value: string): string | null {
  let text = ''
  let cursor = 0
  while (cursor < value.length) {
    const character = value[cursor]
    if (character !== '\\') {
      text += character
      cursor += 1
      continue
    }
    const escape = value[cursor + 1]
    const replacements: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    }
    if (escape === undefined || replacements[escape] === undefined) return null
    text += replacements[escape]
    cursor += 2
  }
  return text
}

// Reads a plain array of quoted strings. Anything richer (nested arrays, inline
// tables, numbers) yields null so the caller leaves the user's line alone.
function parseNotifyArgv(value: string): string[] | null {
  const open = value.indexOf('[')
  if (open === -1) return null
  const argv: string[] = []
  let cursor = open + 1
  let expectsValue = true
  while (cursor < value.length) {
    const character = value[cursor]
    if (character === ']') {
      return /^\s*(?:#[^\n]*)?\s*$/.test(value.slice(cursor + 1)) ? argv : null
    }
    if (/\s/.test(character)) {
      cursor += 1
      continue
    }
    if (character === '#') {
      const newline = value.indexOf('\n', cursor)
      if (newline === -1) return null
      cursor = newline + 1
      continue
    }
    if (character === ',') {
      if (expectsValue) return null
      expectsValue = true
      cursor += 1
      continue
    }
    if (!expectsValue || (character !== '"' && character !== "'")) return null
    if (value.startsWith('"""', cursor) || value.startsWith("'''", cursor)) return null
    const end = skipTomlString(value, cursor, character)
    if (end > value.length || value[end - 1] !== character) return null
    const raw = value.slice(cursor + 1, end - 1)
    const entry = character === '"' ? unescapeTomlBasicString(raw) : raw
    if (entry === null) return null
    argv.push(entry)
    expectsValue = false
    cursor = end
  }
  return null
}

function codexNotifyBlock(bridgePath: string, forwardTo: readonly string[] | null): string[] {
  return [
    forwardTo ? `${CODEX_NOTIFY_MARKER} wrapped=${JSON.stringify(forwardTo)}` : CODEX_NOTIFY_MARKER,
    `notify = ["node", ${JSON.stringify(bridgePath)}]`,
  ]
}

function wrappedFromMarker(line: string | undefined): {
  managed: boolean
  forwardTo: string[] | null
} {
  const match = line === undefined ? null : CODEX_NOTIFY_MARKER_LINE.exec(line)
  if (!match) return { managed: false, forwardTo: null }
  if (match[1] === undefined) return { managed: true, forwardTo: null }
  try {
    const parsed: unknown = JSON.parse(match[1])
    const valid = Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((entry) => typeof entry === 'string')
    return { managed: true, forwardTo: valid ? (parsed as string[]) : null }
  } catch {
    return { managed: true, forwardTo: null }
  }
}

export function mergeCodexNotify(content: string, bridgePath: string): CodexNotifyMerge {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const lines = body.length ? body.split('\n') : []
  const { end, notify, unterminated } = scanTopLevelNotify(lines)
  const untouched = (warning: string): CodexNotifyMerge => ({
    content,
    changed: false,
    forwardTo: null,
    warning,
  })

  if (unterminated) {
    return untouched('its top-level notify value could not be read, so Commando left the file alone')
  }

  let next: string[]
  let forwardTo: string[] | null = null
  if (notify === null) {
    const block = codexNotifyBlock(bridgePath, null)
    if (end > 0 && lines[end - 1].trim().length > 0) block.unshift('')
    if (end < lines.length && lines[end].trim().length > 0) block.push('')
    next = [...lines.slice(0, end), ...block, ...lines.slice(end)]
  } else {
    const marker = wrappedFromMarker(lines[notify.start - 1])
    const argv = parseNotifyArgv(notify.value)
    const ownsArgv = argv !== null &&
      argv.some((entry) => entry === bridgePath || entry.endsWith(`/${CODEX_BRIDGE_FILENAME}`))
    if (!marker.managed && !ownsArgv) {
      if (argv === null) {
        return untouched(
          'it already sets a top-level notify that Commando cannot safely rewrite, so the file was left alone',
        )
      }
      forwardTo = argv.length ? argv : null
    } else {
      // A hand-edited notify that no longer points at the bridge is the newer
      // intent, so wrap that instead of whatever the marker remembered.
      forwardTo = argv !== null && argv.length > 0 && !ownsArgv ? argv : marker.forwardTo
    }
    const start = marker.managed ? notify.start - 1 : notify.start
    next = [
      ...lines.slice(0, start),
      ...codexNotifyBlock(bridgePath, forwardTo),
      ...lines.slice(notify.end + 1),
    ]
  }

  const merged = next.length ? `${next.join('\n')}\n` : ''
  return { content: merged, changed: merged !== content, forwardTo, warning: null }
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

function installedClaudeBridgePaths(settings: JsonObject): Set<string> {
  const paths = new Set<string>()
  if (!isObject(settings.hooks)) return paths
  for (const configured of Object.values(settings.hooks)) {
    if (!Array.isArray(configured)) continue
    for (const entry of configured) {
      if (!isObject(entry) || !Array.isArray(entry.hooks)) continue
      for (const hook of entry.hooks) {
        if (!isObject(hook) || hook.command !== 'node' || !Array.isArray(hook.args)) continue
        if (!hook.args.includes(CLAUDE_HOOK_MARKER)) continue
        const [path] = hook.args
        if (typeof path === 'string') paths.add(resolve(path))
      }
    }
  }
  return paths
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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

function isWithin(directory: string, path: string): boolean {
  const offset = relative(directory, path)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

async function readCodexConfig(path: string): Promise<{ mode: number; content: string }> {
  const mode = await existingFileMode(path, 0o600)
  try {
    return { mode, content: await readFile(path, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode, content: '' }
    throw error
  }
}

export class AgentHookInstaller {
  readonly paths: AgentHookInstallResult
  private readonly home: string

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
    this.home = resolvedHome
    const configuredCodexHome = options.home === undefined ? process.env.CODEX_HOME : undefined
    if (configuredCodexHome !== undefined && configuredCodexHome.trim().length === 0) {
      throw new Error('CODEX_HOME must not be empty')
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
      codexBridgePath: resolve(
        options.codexBridgePath
          ?? resolve(resolvedHome, '.commando', 'hooks', CODEX_BRIDGE_FILENAME),
      ),
      codexConfigPath: resolve(
        options.codexConfigPath
          ?? (configuredCodexHome
            ? resolve(configuredCodexHome, 'config.toml')
            : resolve(resolvedHome, '.codex', 'config.toml')),
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

  /**
   * Bridge paths already written into the Claude settings by a previous install that no
   * longer resolve to a usable bridge. A settings file with no Commando hooks yields an
   * empty list: staleness is only about repairing our own entries, never about opting a
   * profile in.
   */
  async staleClaudeBridgePaths(): Promise<string[]> {
    // A profile outside this home belongs to someone else: a daemon running with an overridden
    // HOME (tests, sandboxes) must never rewrite the developer's real settings to point at its
    // own bridge. Such a profile is repaired by installing from its own home instead.
    if (!isWithin(this.home, this.paths.claudeSettingsPath)) return []
    const { settings } = await readClaudeSettings(this.paths.claudeSettingsPath)
    const installed = installedClaudeBridgePaths(settings)
    if (installed.size === 0) return []
    const stale: string[] = []
    for (const path of installed) {
      if (path !== this.paths.claudeBridgePath || !(await isReadableFile(path))) stale.push(path)
    }
    return stale.sort()
  }

  async install(): Promise<AgentHookInstallResult> {
    const instructions = agentIntegrationInstructions(this.paths.prMarkerCliPath, this.paths.sessionBriefCliPath)
    await new AgentHookTokenStore({ path: this.paths.tokenPath }).loadOrCreate()
    await mkdir(dirname(this.paths.claudeBridgePath), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.paths.claudeBridgePath), 0o700)
    await writeAtomically(
      this.paths.claudeBridgePath,
      generatedClaudeBridge(this.paths.tokenPath, instructions),
      0o600,
    )
    await writeAtomically(
      this.paths.openCodePluginPath,
      generatedOpenCodePlugin(this.paths.tokenPath, instructions),
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

    const codexNotifyWarning = await this.installCodexNotify()

    const { mode, settings } = await readClaudeSettings(this.paths.claudeSettingsPath)
    const merged = mergeClaudeHooks(settings, this.paths.claudeBridgePath)
    await writeAtomically(
      this.paths.claudeSettingsPath,
      `${JSON.stringify(merged, null, 2)}\n`,
      mode,
    )
    return {
      ...this.paths,
      ...(codexNotifyWarning ? { codexNotifyWarning } : {}),
    }
  }

  // Codex only learns about the bridge through `notify`, so the script is
  // written after the merge decided which notifier (if any) it must chain to.
  private async installCodexNotify(): Promise<string | null> {
    const existing = await readCodexConfig(this.paths.codexConfigPath)
    const merged = mergeCodexNotify(existing.content, this.paths.codexBridgePath)
    await writeAtomically(
      this.paths.codexBridgePath,
      generatedCodexBridge(this.paths.tokenPath, merged.forwardTo),
      0o600,
    )
    if (merged.changed) {
      await writeAtomically(this.paths.codexConfigPath, merged.content, existing.mode)
    }
    return merged.warning === null ? null : `${this.paths.codexConfigPath}: ${merged.warning}`
  }
}

export async function installAgentStatusHooks(
  options: AgentHookInstallerOptions = {},
): Promise<AgentHookInstallResult> {
  return new AgentHookInstaller(options).install()
}

/**
 * Repair Claude hooks that point at a bridge which has moved or disappeared — a test run or
 * a stale profile can leave every hook throwing MODULE_NOT_FOUND in each new session. Only
 * profiles inside this home that already carry Commando hooks are touched, and an unchanged
 * profile is left alone.
 */
export async function repairAgentStatusHooks(
  options: AgentHookInstallerOptions = {},
): Promise<AgentHookRepairResult> {
  const installer = new AgentHookInstaller(options)
  const staleBridgePaths = await installer.staleClaudeBridgePaths()
  if (staleBridgePaths.length === 0) return { repaired: false, staleBridgePaths }
  await installer.install()
  return { repaired: true, staleBridgePaths }
}
