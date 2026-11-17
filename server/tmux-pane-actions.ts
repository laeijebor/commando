import { execFile } from 'node:child_process'
import {
  tmuxSocketArgs,
  type TmuxProcessExecutor,
  type TmuxSocketEnvironment,
} from './tmux-session-actions.js'
import { emptyPaneCommand } from './tmux-create.js'
import { EMPTY_PANE_OPTION, PANE_SHELL_OPTION, paneShellSessionName } from '../shared/tmux-create.js'

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

  /**
   * Closes a pane. tmux ends a session with its last pane, so a session's only pane is
   * emptied instead: it idles in `cwd` as a fresh pane until something is launched into it.
   */
  async delete(paneId: string, cwd?: string): Promise<'killed' | 'emptied'> {
    const target = validateTmuxPaneId(paneId)
    const counts = (await this.run(['display-message', '-p', '-t', target, '#{session_windows} #{window_panes}'])).trim()
    if (counts !== '1 1') {
      await this.run(['kill-pane', '-t', target])
      return 'killed'
    }
    // One tmux command list, so the pane is never left running the idle process unmarked.
    // Dropping its target identity and chat lineage makes it a new pane, as after a close.
    await this.run([
      'respawn-pane', '-k', '-t', target, ...(cwd ? ['-c', cwd] : []), emptyPaneCommand(),
      ';', 'set-option', '-p', '-F', '-t', target, EMPTY_PANE_OPTION, '#{pane_pid}',
      ...['@commando_target', '@commando_opened_by', '@commando_chat_title'].flatMap((option) => [';', 'set-option', '-p', '-u', '-t', target, option]),
      ';', 'select-pane', '-t', target, '-T', '',
    ])
    return 'emptied'
  }

  /**
   * The pane's Terminal-tab shell: a detached session of its own, so it never reflows the
   * pane's window. Started in `cwd` on first use and reused afterwards.
   */
  async ensureShell(paneId: string, cwd?: string): Promise<string> {
    const anchor = validateTmuxPaneId(paneId)
    const existing = await this.shellSession(anchor)
    if (existing) {
      const shellPaneId = (await this.run(['list-panes', '-t', existing, '-F', '#{pane_id}'])).split('\n', 1)[0].trim()
      if (PANE_ID.test(shellPaneId)) return shellPaneId
    }
    const name = paneShellSessionName(anchor)
    // One tmux command list, so the session is never listed without its marker.
    const created = (await this.run([
      'new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, ...(cwd ? ['-c', cwd] : []),
      ';', 'set-option', '-t', `=${name}`, PANE_SHELL_OPTION, anchor,
    ])).trim()
    if (!PANE_ID.test(created)) throw new TmuxPaneActionError('tmux did not report the new shell pane')
    return created
  }

  /** Ends the pane's Terminal-tab shell, if it has one. */
  async closeShell(paneId: string): Promise<void> {
    const session = await this.shellSession(validateTmuxPaneId(paneId))
    if (session) await this.run(['kill-session', '-t', session])
  }

  private async shellSession(anchorPaneId: string): Promise<string | undefined> {
    const sessions = await this.run(['list-sessions', '-F', `#{session_id} #{${PANE_SHELL_OPTION}}`])
    return sessions.split('\n').map((line) => line.trim().split(' ')).find(([, anchor]) => anchor === anchorPaneId)?.[0]
  }

  private async run(args: readonly string[]): Promise<string> {
    const { stdout } = await this.execute('tmux', [...this.socketArgs, ...args], {
      encoding: 'utf8',
      maxBuffer: ACTION_BUFFER_BYTES,
      shell: false,
      timeout: ACTION_TIMEOUT_MS,
      windowsHide: true,
    })
    return stdout
  }
}
