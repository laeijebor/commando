import { execFile } from 'node:child_process'
import {
  tmuxSocketArgs,
  type TmuxProcessExecutor,
  type TmuxSocketEnvironment,
} from './tmux-session-actions.js'

const PANE_ID = /^%\d+$/
const ACTION_TIMEOUT_MS = 3_000
const ACTION_BUFFER_BYTES = 64 * 1024
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export class TmuxPaneActionError extends Error {
  readonly stderr: string

  constructor(message: string, stderr = '') {
    super(message)
    this.name = 'TmuxPaneActionError'
    this.stderr = stderr
  }
}

export function validateTmuxPaneId(value: unknown): string {
  if (typeof value !== 'string' || !PANE_ID.test(value)) {
    throw new Error('Invalid tmux pane id')
  }
  return value
}

export function validateTmuxPaneTitle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error('Pane title must be 1-128 bytes without surrounding whitespace or control characters')
  }
  return value
}

const defaultExecutor: TmuxProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new TmuxPaneActionError(
            error.killed ? 'tmux pane action timed out' : 'tmux pane action failed',
            stderr.slice(0, 2_000),
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })

export class TmuxPaneActions {
  private readonly socketArgs: string[]

  constructor(
    private readonly execute: TmuxProcessExecutor = defaultExecutor,
    environment: TmuxSocketEnvironment = process.env,
  ) {
    this.socketArgs = tmuxSocketArgs(environment)
  }

  async rename(paneId: string, title: string): Promise<void> {
    const target = validateTmuxPaneId(paneId)
    const validatedTitle = validateTmuxPaneTitle(title)
    await this.run(['select-pane', '-t', target, '-T', validatedTitle])
  }

  async delete(paneId: string): Promise<void> {
    const target = validateTmuxPaneId(paneId)
    await this.run(['kill-pane', '-t', target])
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
