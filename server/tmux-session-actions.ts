import { execFile } from 'node:child_process'

const SESSION_ID = /^\$\d+$/
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,128}$/
const ACTION_TIMEOUT_MS = 3_000
const ACTION_BUFFER_BYTES = 64 * 1024

export type TmuxProcessOptions = {
  encoding: 'utf8'
  maxBuffer: number
  shell: false
  timeout: number
  windowsHide: true
}

export type TmuxProcessExecutor = (
  file: 'tmux',
  args: readonly string[],
  options: TmuxProcessOptions,
) => Promise<{ stdout: string; stderr: string }>

export type TmuxSocketEnvironment = {
  COMMANDO_TMUX_SOCKET_PATH?: string
  COMMANDO_TMUX_SOCKET_NAME?: string
}

export class TmuxSessionActionError extends Error {
  readonly stderr: string

  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'TmuxSessionActionError'
    this.stderr = stderr
  }
}

export function validateTmuxSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new Error('Invalid tmux session id')
  }
  return value
}

export function validateTmuxSessionName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > 128
  ) {
    throw new Error('Session name must be between 1 and 128 characters without surrounding whitespace')
  }
  if (/[\u0000-\u001f\u007f:]/.test(value)) {
    throw new Error('Session name contains unsupported characters')
  }
  return value
}

export function tmuxSocketArgs(environment: TmuxSocketEnvironment): string[] {
  const socketPath = environment.COMMANDO_TMUX_SOCKET_PATH
  const socketName = environment.COMMANDO_TMUX_SOCKET_NAME
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

const defaultExecutor: TmuxProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new TmuxSessionActionError(
            error.killed ? 'tmux session action timed out' : 'tmux session action failed',
            stderr.slice(0, 2_000),
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })

export class TmuxSessionActions {
  private readonly socketArgs: string[]

  constructor(
    private readonly execute: TmuxProcessExecutor = defaultExecutor,
    environment: TmuxSocketEnvironment = process.env,
  ) {
    this.socketArgs = tmuxSocketArgs(environment)
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const target = validateTmuxSessionId(sessionId)
    const validatedName = validateTmuxSessionName(name)
    await this.run(['rename-session', '-t', target, validatedName])
  }

  async delete(sessionId: string): Promise<void> {
    const target = validateTmuxSessionId(sessionId)
    await this.run(['kill-session', '-t', target])
  }

  private async run(args: readonly string[]): Promise<void> {
    await this.execute('tmux', [...this.socketArgs, ...args], {
      encoding: 'utf8',
      maxBuffer: ACTION_BUFFER_BYTES,
      shell: false,
      timeout: ACTION_TIMEOUT_MS,
      windowsHide: true,
    })
  }
}
