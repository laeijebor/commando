import { execFile } from 'node:child_process'
import type {
  CreateTmuxPaneRequest,
  CreateTmuxSessionRequest,
  CreateTmuxWindowRequest,
  TmuxCreatedTarget,
} from '../shared/tmux-create.js'

const COMMAND_TIMEOUT_MS = 3_000
const COMMAND_BUFFER_BYTES = 64 * 1024
const FIELD_SEPARATOR = '\u001f'
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,128}$/
const SESSION_ID = /^\$\d+$/
const WINDOW_ID = /^@\d+$/
const PANE_ID = /^%\d+$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u
const CREATE_FORMAT = [
  '#{session_id}',
  '#{session_name}',
  '#{window_id}',
  '#{window_index}',
  '#{window_name}',
  '#{pane_id}',
  '#{pane_index}',
  '#{pane_current_path}',
].join(FIELD_SEPARATOR)

export type TmuxCreateCommandRunner = (args: readonly string[]) => Promise<string>

export class TmuxCreateCommandError extends Error {
  readonly code: string | number | undefined
  readonly stderr: string

  constructor(message: string, code: string | number | undefined, stderr: string) {
    super(message)
    this.name = 'TmuxCreateCommandError'
    this.code = code
    this.stderr = stderr
  }
}

export function tmuxSocketArgsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const socketPath = env.COMMANDO_TMUX_SOCKET_PATH
  const socketName = env.COMMANDO_TMUX_SOCKET_NAME
  if (socketPath && socketName) {
    throw new Error('Set only one of COMMANDO_TMUX_SOCKET_PATH or COMMANDO_TMUX_SOCKET_NAME')
  }
  if (socketPath) {
    if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
      throw new Error('COMMANDO_TMUX_SOCKET_PATH must be an absolute path')
    }
    return ['-S', socketPath]
  }
  if (socketName) {
    if (!SOCKET_NAME.test(socketName)) {
      throw new Error('COMMANDO_TMUX_SOCKET_NAME contains unsupported characters')
    }
    return ['-L', socketName]
  }
  return []
}

export function runTmuxCreateCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: COMMAND_BUFFER_BYTES,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new TmuxCreateCommandError(
              error.killed ? 'tmux create command timed out' : 'tmux create command failed',
              error.code ?? undefined,
              stderr.slice(0, 2_000),
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

function validatedName(value: unknown, field: string, session = false): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${field} must be 1-128 bytes without surrounding whitespace or control characters`)
  }
  if (session && /[.:]/u.test(value)) {
    throw new Error(`${field} cannot contain a colon or period`)
  }
  return value
}

function validatedPath(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    Buffer.byteLength(value, 'utf8') > 4_096 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error('cwd must be an absolute path of at most 4096 bytes without control characters')
  }
  return value
}

function optionalName(value: unknown, field: string): string | undefined {
  return value === undefined || value === '' ? undefined : validatedName(value, field)
}

function parseCreatedTarget(output: string, kind: TmuxCreatedTarget['kind']): TmuxCreatedTarget {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0)
  if (lines.length !== 1) throw new Error('tmux returned an invalid create response')
  const fields = lines[0].split(FIELD_SEPARATOR)
  if (fields.length !== 8) throw new Error('tmux returned an invalid create response')

  const [
    sessionId,
    sessionName,
    windowId,
    windowIndexValue,
    windowName,
    paneId,
    paneIndexValue,
    panePath,
  ] = fields
  const windowIndex = /^\d+$/u.test(windowIndexValue) ? Number(windowIndexValue) : NaN
  const paneIndex = /^\d+$/u.test(paneIndexValue) ? Number(paneIndexValue) : NaN
  if (
    !SESSION_ID.test(sessionId) ||
    sessionName.length === 0 ||
    !WINDOW_ID.test(windowId) ||
    !PANE_ID.test(paneId) ||
    !Number.isSafeInteger(windowIndex) ||
    windowIndex < 0 ||
    !Number.isSafeInteger(paneIndex) ||
    paneIndex < 0 ||
    CONTROL_CHARACTER.test(sessionName) ||
    CONTROL_CHARACTER.test(windowName) ||
    CONTROL_CHARACTER.test(panePath) ||
    !panePath.startsWith('/')
  ) {
    throw new Error('tmux returned an invalid create response')
  }

  return {
    kind,
    sessionId,
    sessionName,
    windowId,
    windowIndex,
    windowName,
    paneId,
    paneIndex,
    panePath,
  }
}

export class TmuxCreator {
  constructor(
    private readonly run: TmuxCreateCommandRunner = runTmuxCreateCommand,
    private readonly socketArgs: readonly string[] = tmuxSocketArgsFromEnv(),
  ) {}

  async createSession(input: CreateTmuxSessionRequest): Promise<TmuxCreatedTarget> {
    const name = validatedName(input.name, 'session name', true)
    const windowName = optionalName(input.windowName, 'window name')
    const cwd = validatedPath(input.cwd)
    const args = [
      ...this.socketArgs,
      'new-session',
      '-d',
      '-P',
      '-F',
      CREATE_FORMAT,
      '-s',
      name,
    ]
    if (windowName) args.push('-n', windowName)
    if (cwd) args.push('-c', cwd)
    return parseCreatedTarget(await this.run(args), 'session')
  }

  async createWindow(input: CreateTmuxWindowRequest): Promise<TmuxCreatedTarget> {
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) {
      throw new Error('Invalid tmux session id')
    }
    const name = optionalName(input.name, 'window name')
    const cwd = validatedPath(input.cwd)
    const args = [
      ...this.socketArgs,
      'new-window',
      '-d',
      '-P',
      '-F',
      CREATE_FORMAT,
      '-t',
      input.sessionId,
    ]
    if (name) args.push('-n', name)
    if (cwd) args.push('-c', cwd)
    return parseCreatedTarget(await this.run(args), 'window')
  }

  async createPane(input: CreateTmuxPaneRequest): Promise<TmuxCreatedTarget> {
    if (
      typeof input.targetId !== 'string' ||
      (!WINDOW_ID.test(input.targetId) && !PANE_ID.test(input.targetId))
    ) {
      throw new Error('Invalid tmux window or pane id')
    }
    if (input.direction !== 'horizontal' && input.direction !== 'vertical') {
      throw new Error('Invalid tmux split direction')
    }
    const cwd = validatedPath(input.cwd)
    const args = [
      ...this.socketArgs,
      'split-window',
      '-d',
      input.direction === 'horizontal' ? '-h' : '-v',
      '-P',
      '-F',
      CREATE_FORMAT,
      '-t',
      input.targetId,
    ]
    if (cwd) args.push('-c', cwd)
    return parseCreatedTarget(await this.run(args), 'pane')
  }
}
