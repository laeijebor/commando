import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  MAX_PASTE_BYTES,
  type CommandoSnapshot,
  type LayoutSpec,
  type SpecialKey,
} from '../shared/protocol.js'
import {
  PANE_FORMAT,
  SESSION_FORMAT,
  WINDOW_FORMAT,
  parsePaneProcesses,
  parseTmuxSnapshot,
} from './tmux-parsers.js'
import { OpenPortScanner } from './open-ports.js'
import type { OpenPortTarget, TerminatedSessionPorts } from './open-ports.js'
import {
  TmuxControllerPool,
  type PaneSeedCapture,
  type TmuxControllerHandlers,
} from './tmux-control.js'
import { TmuxResizeLeaseManager } from './tmux-resize-lease.js'

const DISCOVERY_TIMEOUT_MS = 1_500
const DISCOVERY_BUFFER_BYTES = 4 * 1024 * 1024
const SOCKET_NAME = /^[A-Za-z0-9._-]{1,128}$/
const PANE_ID = /^%\d+$/
const PASTE_BUFFER_NAME = /^[A-Za-z0-9._-]{1,128}$/

type CommandOptions = {
  timeout: number
  maxBuffer: number
}

export class TmuxCommandError extends Error {
  readonly code: string | number | undefined
  readonly stderr: string

  constructor(message: string, code: string | number | undefined, stderr: string) {
    super(message)
    this.name = 'TmuxCommandError'
    this.code = code
    this.stderr = stderr
  }
}

function runTmux(
  args: readonly string[],
  options: CommandOptions,
  input?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = execFile(
      'tmux',
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: options.maxBuffer,
        shell: false,
        timeout: options.timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new TmuxCommandError(
              error.killed ? 'tmux command timed out' : 'tmux command failed',
              error.code ?? undefined,
              stderr.slice(0, 2_000),
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
    if (input !== undefined) {
      if (!process.stdin) {
        process.kill()
        reject(new Error('tmux command stdin is unavailable'))
        return
      }
      process.stdin.on('error', () => undefined)
      process.stdin.end(input)
    }
  })
}

export function pasteBufferCommands(paneId: string, bufferName: string) {
  if (!PANE_ID.test(paneId)) throw new Error('Invalid tmux pane id')
  if (!PASTE_BUFFER_NAME.test(bufferName)) throw new Error('Invalid tmux paste buffer name')
  return {
    load: ['load-buffer', '-b', bufferName, '-'],
    paste: ['paste-buffer', '-p', '-d', '-b', bufferName, '-t', paneId],
    cleanup: ['delete-buffer', '-b', bufferName],
  }
}

function isNoServer(error: unknown): boolean {
  return (
    error instanceof TmuxCommandError &&
    /(?:no server running|failed to connect to server|no sessions)/i.test(error.stderr)
  )
}

function configuredSocketArgs(): string[] {
  const socketPath = process.env.COMMANDO_TMUX_SOCKET_PATH
  const socketName = process.env.COMMANDO_TMUX_SOCKET_NAME
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

export class TmuxClient {
  private readonly socketArgs = configuredSocketArgs()
  private readonly controllers = new TmuxControllerPool(this.socketArgs)
  private readonly openPorts = new OpenPortScanner()
  private readonly resizeLeases = new TmuxResizeLeaseManager((args) =>
    this.run(args, { timeout: 3_000, maxBuffer: 64 * 1024 }),
  )

  private run(
    args: readonly string[],
    options: CommandOptions,
    input?: Buffer,
  ): Promise<string> {
    return runTmux([...this.socketArgs, ...args], options, input)
  }

  async discover(revision: number, capturedAt = Date.now()): Promise<CommandoSnapshot> {
    try {
      const [sessions, windows, panes] = await Promise.all([
        this.run(['list-sessions', '-F', SESSION_FORMAT], {
          timeout: DISCOVERY_TIMEOUT_MS,
          maxBuffer: DISCOVERY_BUFFER_BYTES,
        }),
        this.run(['list-windows', '-a', '-F', WINDOW_FORMAT], {
          timeout: DISCOVERY_TIMEOUT_MS,
          maxBuffer: DISCOVERY_BUFFER_BYTES,
        }),
        this.run(['list-panes', '-a', '-F', PANE_FORMAT], {
          timeout: DISCOVERY_TIMEOUT_MS,
          maxBuffer: DISCOVERY_BUFFER_BYTES,
        }),
      ])
      const snapshot = parseTmuxSnapshot(sessions, windows, panes, revision, capturedAt)
      snapshot.ports = await this.openPorts.scan(parsePaneProcesses(panes), capturedAt)
      return snapshot
    } catch (error) {
      if (isNoServer(error)) {
        return {
          revision,
          capturedAt,
          sessions: [],
          windows: [],
          panes: [],
          ports: [],
        }
      }
      throw error
    }
  }

  async terminatePort(target: OpenPortTarget): Promise<CommandoSnapshot['ports'][number]> {
    const panes = await this.run(['list-panes', '-a', '-F', PANE_FORMAT], {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: DISCOVERY_BUFFER_BYTES,
    })
    return this.openPorts.terminatePort(parsePaneProcesses(panes), target)
  }

  async terminateSessionPorts(
    sessionId: string,
    expectedTargets: OpenPortTarget[],
  ): Promise<TerminatedSessionPorts> {
    const panes = await this.run(['list-panes', '-a', '-F', PANE_FORMAT], {
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: DISCOVERY_BUFFER_BYTES,
    })
    return this.openPorts.terminateSessionPorts(parsePaneProcesses(panes), sessionId, expectedTargets)
  }

  setControllerHandlers(handlers: TmuxControllerHandlers): void {
    this.controllers.setHandlers(handlers)
  }

  setRequiredSessions(sessionIds: ReadonlySet<string>): void {
    this.controllers.setRequiredSessions(sessionIds)
  }

  capturePane(sessionId: string, paneId: string): Promise<Buffer> {
    return this.controllers.capturePane(sessionId, paneId)
  }

  capturePaneSeed(
    sessionId: string,
    paneId: string,
    deliver: (capture: PaneSeedCapture) => void | Promise<void>,
  ): Promise<PaneSeedCapture> {
    return this.controllers.capturePaneSeed(sessionId, paneId, deliver)
  }

  sendText(sessionId: string, paneId: string, data: string): Promise<void> {
    return this.controllers.sendText(sessionId, paneId, data)
  }

  sendKey(sessionId: string, paneId: string, key: SpecialKey): Promise<void> {
    return this.controllers.sendKey(sessionId, paneId, key)
  }

  resizePane(ownerId: string, paneId: string, cols: number, rows: number): Promise<boolean> {
    return this.resizeLeases.resize(ownerId, paneId, cols, rows)
  }

  applyWindowLayout(
    ownerId: string,
    windowId: string,
    spec: LayoutSpec,
  ): Promise<boolean> {
    return this.resizeLeases.applyLayout(ownerId, windowId, spec)
  }

  setWindowLayout(windowId: string, spec: LayoutSpec): Promise<boolean> {
    return this.resizeLeases.setLayout(windowId, spec)
  }

  releasePaneResize(ownerId: string, expectedPaneId?: string): Promise<boolean> {
    return this.resizeLeases.release(ownerId, expectedPaneId)
  }

  releaseWindowPaneResizes(windowId: string): Promise<boolean> {
    return this.resizeLeases.releaseWindowForAll(windowId)
  }

  releaseAllPaneResizes(): Promise<void> {
    return this.resizeLeases.releaseAll()
  }

  async pasteText(paneId: string, data: string): Promise<void> {
    const input = Buffer.from(data, 'utf8')
    if (input.length === 0 || input.length > MAX_PASTE_BYTES || data.includes('\0')) {
      throw new Error('Invalid tmux paste data')
    }

    const commands = pasteBufferCommands(paneId, `commando-paste-${randomUUID()}`)
    const options = { timeout: 3_000, maxBuffer: 64 * 1024 }
    await this.run(commands.load, options, input)
    try {
      await this.run(commands.paste, options)
    } catch (error) {
      await this.run(commands.cleanup, options).catch(() => undefined)
      throw error
    }
  }

  close(): void {
    this.controllers.close()
  }
}
