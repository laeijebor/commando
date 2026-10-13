import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import type { ExternalAgentRuntime } from '../../shared/agent-chat.js'
import { hostRunsInPane } from '../agent-host-hub.js'

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  tty: string
  startedAt: number
  command: string
}

export interface AgentProcess extends ProcessRow {
  runtime: ExternalAgentRuntime
  label: string
  resume: boolean
  resumeId?: string
  cwdOverride?: string
  model?: string
  effort?: string
  prompt?: string
}

export function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export async function readProcesses(): Promise<ProcessRow[]> {
  return parseProcesses(await runFile('ps', ['-axwwo', 'pid=,ppid=,pgid=,tty=,lstart=,args=']))
}

export function parseProcesses(output: string): ProcessRow[] {
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)
    if (!match) return []
    const startedAt = Date.parse(match[5]!)
    const tty = match[4] === '?' ? '??' : match[4]!
    return Number.isFinite(startedAt) ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tty, startedAt, command: match[6]! }] : []
  })
}

/** ps joins argv with spaces; quotes survive when a launcher supplied them. */
export function commandWords(command: string): string[] {
  return (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? []).map((word) => word.replace(/^(['"])(.*)\1$/s, '$2'))
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 80) ?? ''
}

function executable(words: string[]): { name: string; args: string[] } {
  let index = 0
  if (/^(node|nodejs|bun)(?:\.exe)?$/.test(basename(words[0] ?? ''))) {
    index = 1
    while (words[index]?.startsWith('-')) index += 1
  }
  return { name: basename(words[index] ?? '').replace(/\.js$/, ''), args: words.slice(index + 1) }
}

export function recognizeAgent(command: string): Pick<AgentProcess, 'runtime' | 'label' | 'resume' | 'resumeId' | 'cwdOverride' | 'model' | 'effort' | 'prompt'> | null {
  const { name, args } = executable(commandWords(command))
  if (name === 'codex' && args[0] === 'exec') {
    return { runtime: 'codex', label: 'codex exec', ...codexArguments(args.slice(1)) }
  }
  if (name === 'claude' && args.some((arg) => arg === '-p' || arg === '--print')
    && !args.some((arg, index) => (arg === '--input-format' && args[index + 1] === 'stream-json') || arg === '--input-format=stream-json')) {
    return { runtime: 'claude', label: 'claude -p', ...claudeResume(args), prompt: promptText(args, ['-r', '--input-format', '--permission-mode', '--allowedTools', '--disallowedTools', '--system-prompt', '--append-system-prompt', '--max-turns', '--session-id', '--effort', '--settings', '--setting-sources', '--mcp-config', '--fallback-model', '--max-budget-usd', '--json-schema']) }
  }
  if ((name === 'agent' || name === 'cursor-agent') && args.some((arg) => arg === '-p' || arg === '--print')) {
    return { runtime: 'cursor', label: promptArgument(args) || 'Cursor agent', resume: false }
  }
  if (name === 'opencode' && args[0] === 'run') {
    return { runtime: 'opencode', label: promptArgument(args.slice(1)) || 'opencode run', resume: false }
  }
  return null
}

function claudeResume(args: string[]): Pick<AgentProcess, 'resume' | 'resumeId'> {
  let resumeId: string | undefined
  let continuing = false
  let fork = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--') break
    if (args[index] === '--fork-session') fork = true
    if (args[index] === '-c' || args[index] === '--continue') continuing = true
    const flag = args[index]!.match(/^(--resume|-r|--session-id)(?:=(.*))?$/)
    if (!flag) continue
    const value = flag[2] ?? args[++index] ?? ''
    if (/^[A-Za-z0-9_-]{1,200}$/.test(value)) resumeId = value
  }
  return fork ? { resume: false } : { resume: continuing || Boolean(resumeId), ...(resumeId ? { resumeId } : {}) }
}

const codexValueFlags = new Set(['-m', '--model', '-c', '--config', '-C', '--cd', '-s', '--sandbox', '-p', '--profile', '-o', '--output-last-message', '-i', '--image', '--color', '--output-schema', '-a', '--ask-for-approval', '--add-dir', '--enable', '--disable', '--local-provider', '--thread-source'])

function codexArguments(args: string[]): Pick<AgentProcess, 'resume' | 'resumeId' | 'prompt' | 'cwdOverride' | 'model' | 'effort'> {
  const options: Pick<AgentProcess, 'cwdOverride' | 'model' | 'effort'> = {}
  const positional: string[] = []
  let literal = false
  let firstPositional = true
  let resume = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!literal && arg === '--') { literal = true; continue }
    if (literal || arg === '-' || !arg.startsWith('-')) {
      if (firstPositional && !literal && arg === 'resume') resume = true
      else positional.push(arg)
      firstPositional = false
      continue
    }
    const flag = arg.match(/^([^=]+)(?:=(.*))?$/s)!
    if (!codexValueFlags.has(flag[1]!)) continue
    const value = (flag[2] ?? args[++index] ?? '').replace(/^(['"])(.*)\1$/s, '$2')
    if (!value) continue
    if (flag[1] === '-C' || flag[1] === '--cd') options.cwdOverride = value
    else if (flag[1] === '-m' || flag[1] === '--model') options.model = value
    else if (flag[1] === '-c' || flag[1] === '--config') {
      const effort = value.match(/^model_reasoning_effort\s*=\s*(.+)$/)?.[1]?.trim().replace(/^(['"])(.*)\1$/s, '$2')
      if (effort) options.effort = effort
    }
  }
  const resumeId = resume && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(positional[0] ?? '') ? positional.shift() : undefined
  const prompt = positional.includes('-') ? undefined : positional.join(' ').trim() || undefined
  return { ...options, resume, ...(resumeId ? { resumeId } : {}), prompt }
}

function promptText(args: string[], extraValueFlags: string[] = []): string | undefined {
  const values: string[] = []
  const takesValue = new Set(['--model', '-m', '--session', '-s', '--format', '--agent', '--file', '-f', '--title', '--attach', '--port', '--mode', '--output-format', '--resume', '--workspace', '--api-key', '--variant', ...extraValueFlags])
  let positional = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!positional && arg === '--') { positional = true; continue }
    if (!positional && takesValue.has(arg)) { index += 1; continue }
    if (arg === '-') return undefined
    if (!positional && arg.startsWith('-')) continue
    values.push(arg)
  }
  return values.join(' ').trim() || undefined
}

function promptArgument(args: string[]): string {
  return firstLine(promptText(args) ?? '')
}

function ancestors(rows: Map<number, ProcessRow>, pid: number): ProcessRow[] {
  const result: ProcessRow[] = []
  const seen = new Set<number>([pid])
  let parent = rows.get(rows.get(pid)?.ppid ?? 0)
  while (parent && !seen.has(parent.pid) && result.length < 64) {
    result.push(parent)
    seen.add(parent.pid)
    parent = rows.get(parent.ppid)
  }
  return result
}

export interface ProcessIndex {
  byPid: Map<number, ProcessRow>
  agents: Map<number, AgentProcess>
}

export function indexProcesses(rows: readonly ProcessRow[], recognize = recognizeAgent): ProcessIndex {
  const agents = new Map<number, AgentProcess>()
  for (const row of rows) {
    const agent = recognize(row.command)
    if (agent) agents.set(row.pid, { ...row, ...agent })
  }
  return { byPid: new Map(rows.map((row) => [row.pid, row])), agents }
}

/** A shell below the verified chat host distinguishes Bash launches from SDK children. */
export function findAgentProcesses(rows: readonly ProcessRow[], panePid: number, hostPid: number, index?: ProcessIndex): AgentProcess[] {
  if (!hostRunsInPane(rows, hostPid, panePid)) return []
  const { byPid, agents } = index ?? indexProcesses(rows)
  return [...agents.values()].filter((row) => {
    if (row.pid === hostPid) return false
    const parents = ancestors(byPid, row.pid)
    const hostIndex = parents.findIndex((parent) => parent.pid === hostPid)
    if (hostIndex < 0) return false
    const belowHost = parents.slice(0, hostIndex)
    if (!belowHost.some((parent) => /^(sh|bash|zsh)$/.test(basename(commandWords(parent.command)[0] ?? '').replace(/^-/, '')))) return false
    return !belowHost.some((parent) => agents.has(parent.pid))
  })
}

export function runningCommand(rows: readonly ProcessRow[], run: AgentProcess): { command: string; startedAt: number } | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const shellCommand = (row: ProcessRow): string | undefined => {
    const words = commandWords(row.command)
    if (!/^(sh|bash|zsh)$/.test(basename(words[0] ?? '')) || !/^-[a-z]*c[a-z]*$/.test(words[1] ?? '')) return undefined
    // Claude Code wraps each Bash call in a snapshot preamble around `eval '<command>'`.
    const evaluated = row.command.match(/ && eval '((?:[^']|'\\'')*)' < \/dev\/null/)?.[1]
    return evaluated?.replaceAll(`'\\''`, `'`) || words.slice(2).join(' ') || undefined
  }
  const shells = rows.flatMap((row) => {
    const command = shellCommand(row)
    if (!command) return []
    const parents = ancestors(byPid, row.pid)
    const depth = parents.findIndex((parent) => parent.pid === run.pid)
    if (depth < 0 || parents.slice(0, depth).some((parent) => shellCommand(parent)
      || /^(?:node|nodejs|bun|deno|npm|npx|pnpm|yarn|uv|uvx|python.*)$/.test(basename(commandWords(parent.command)[0] ?? '')))) return []
    return [{ row, command }]
  }).sort((a, b) => b.row.startedAt - a.row.startedAt)
  const shell = shells[0]
  return shell ? { command: shell.command, startedAt: shell.row.startedAt } : undefined
}

export async function processCwd(pid: number): Promise<string | undefined> {
  const output = await runFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).catch(() => '')
  return output.split('\n').find((line) => line.startsWith('n/'))?.slice(1)
}
