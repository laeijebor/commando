import { execFile } from 'node:child_process'
import {
  tmuxSocketArgs,
  TmuxSessionActionError,
  type TmuxProcessExecutor,
  type TmuxProcessOptions,
  type TmuxSocketEnvironment,
} from './tmux-session-actions.js'

const SAVE_INTERVAL_MS = 60 * 60 * 1_000
const SAVE_TIMEOUT_MS = 30_000
const SAVE_BUFFER_BYTES = 64 * 1024
const SAVE_SCRIPT_OPTION = '@resurrect-save-script-path'

type SaveResult = 'saved' | 'unavailable'

type TmuxResurrectSaverOptions = {
  environment?: TmuxSocketEnvironment
  execute?: TmuxProcessExecutor
  intervalMs?: number
  onError?: (error: unknown) => void
}

const processOptions: TmuxProcessOptions = {
  encoding: 'utf8',
  maxBuffer: SAVE_BUFFER_BYTES,
  shell: false,
  timeout: SAVE_TIMEOUT_MS,
  windowsHide: true,
}

const defaultExecutor: TmuxProcessExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(
          new TmuxSessionActionError(
            error.killed ? 'tmux Resurrect save timed out' : 'tmux Resurrect save failed',
            stderr.slice(0, 2_000),
          ),
        )
        return
      }
      resolve({ stdout, stderr })
    })
  })

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function saveScriptPath(stdout: string): string | null {
  const path = stdout.trim()
  if (!path) return null
  if (!path.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('tmux-resurrect save script path must be an absolute path without control characters')
  }
  return path
}

export class TmuxResurrectSaver {
  private readonly socketArgs: string[]
  private readonly execute: TmuxProcessExecutor
  private readonly intervalMs: number
  private readonly onError: (error: unknown) => void
  private saving: Promise<SaveResult> | null = null
  private timer: NodeJS.Timeout | undefined

  constructor(options: TmuxResurrectSaverOptions = {}) {
    this.socketArgs = tmuxSocketArgs(options.environment ?? process.env)
    this.execute = options.execute ?? defaultExecutor
    this.intervalMs = options.intervalMs ?? SAVE_INTERVAL_MS
    this.onError = options.onError ?? (() => {})
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.save().catch(this.onError)
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  save(): Promise<SaveResult> {
    if (this.saving) return this.saving
    this.saving = this.runSave().finally(() => {
      this.saving = null
    })
    return this.saving
  }

  private async runSave(): Promise<SaveResult> {
    const { stdout } = await this.execute(
      'tmux',
      [...this.socketArgs, 'show-options', '-gqv', SAVE_SCRIPT_OPTION],
      processOptions,
    )
    const scriptPath = saveScriptPath(stdout)
    if (!scriptPath) return 'unavailable'

    await this.execute(
      'tmux',
      [...this.socketArgs, 'run-shell', `${shellQuote(scriptPath)} quiet`],
      processOptions,
    )
    return 'saved'
  }
}
