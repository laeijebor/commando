import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import {
  TERMINAL_SCROLLBACK_LINES,
  type PaneTerminalState,
  type SpecialKey,
} from '../shared/protocol.js'
import {
  PANE_TERMINAL_STATE_FORMAT,
  parsePaneTerminalState,
} from './tmux-parsers.js'

const SESSION_ID = /^\$\d+$/
const PANE_ID = /^%\d+$/
const MAX_CONTROL_LINE_BYTES = 1024 * 1024
const MAX_COMMAND_QUEUE = 512
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 3_000
const ATTACH_TIMEOUT_MS = 3_000
const STABLE_CONTROLLER_MS = 10_000
const RESTART_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const
const CONTROL_NOTIFICATIONS = new Set([
  '%client-detached',
  '%client-session-changed',
  '%config-error',
  '%continue',
  '%exit',
  '%extended-output',
  '%layout-change',
  '%message',
  '%pane-mode-changed',
  '%paste-buffer-changed',
  '%paste-buffer-deleted',
  '%pause',
  '%session-changed',
  '%session-renamed',
  '%session-window-changed',
  '%sessions-changed',
  '%subscription-changed',
  '%unlinked-window-add',
  '%unlinked-window-close',
  '%unlinked-window-renamed',
  '%window-add',
  '%window-close',
  '%window-pane-changed',
  '%window-renamed',
])

const KEY_NAMES: Record<SpecialKey, string> = {
  Enter: 'Enter',
  Backspace: 'BSpace',
  Tab: 'Tab',
  Escape: 'Escape',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Home: 'Home',
  End: 'End',
  Insert: 'IC',
  Delete: 'DC',
  PageUp: 'PPage',
  PageDown: 'NPage',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  'C-c': 'C-c',
  'C-d': 'C-d',
  'C-z': 'C-z',
  'C-l': 'C-l',
}

export type ControlModeLine =
  | { type: 'output'; paneId: string; data: Buffer }
  | { type: 'begin' | 'end' | 'error'; id: string }
  | { type: 'notification'; data: Buffer }
  | { type: 'data'; data: Buffer }

export type TmuxControllerHandlers = {
  onOutput?: (sessionId: string, paneId: string, data: Buffer) => void
  onNotification?: (sessionId: string, notification: string) => void
  onReady?: (sessionId: string) => void
  onError?: (sessionId: string, error: Error) => void
}

export type PaneSeedCapture = {
  capture: Buffer
  normalCapture?: Buffer
  terminalState: PaneTerminalState
}

type CommandRequest = {
  command: string
  maxResponseBytes: number
  resolve: (output: Buffer) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

type CommandBlock = {
  id: string
  request: CommandRequest | null
  chunks: Buffer[]
  bytes: number
  overflowed: boolean
}

type ControllerRecord = {
  sessionId: string
  controller?: TmuxSessionController
  startPromise?: Promise<TmuxSessionController>
  leases: number
  generation: number
  restartAttempts: number
  restartNotBefore: number
  stableTimer?: NodeJS.Timeout
}

export class TmuxControlCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TmuxControlCommandError'
  }
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error('Invalid tmux session id')
}

function assertPaneId(paneId: string): void {
  if (!PANE_ID.test(paneId)) throw new Error('Invalid tmux pane id')
}

function startsWith(input: Buffer, prefix: Buffer): boolean {
  return input.length >= prefix.length && input.subarray(0, prefix.length).equals(prefix)
}

export function decodeControlEscapes(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length)
  let readOffset = 0
  let writeOffset = 0

  while (readOffset < input.length) {
    if (
      input[readOffset] === 0x5c &&
      readOffset + 3 < input.length &&
      input[readOffset + 1] >= 0x30 &&
      input[readOffset + 1] <= 0x33 &&
      input[readOffset + 2] >= 0x30 &&
      input[readOffset + 2] <= 0x37 &&
      input[readOffset + 3] >= 0x30 &&
      input[readOffset + 3] <= 0x37
    ) {
      output[writeOffset] =
        (input[readOffset + 1] - 0x30) * 64 +
        (input[readOffset + 2] - 0x30) * 8 +
        (input[readOffset + 3] - 0x30)
      readOffset += 4
      writeOffset += 1
      continue
    }

    output[writeOffset] = input[readOffset]
    readOffset += 1
    writeOffset += 1
  }

  return output.subarray(0, writeOffset)
}

export function normalizeCaptureLineEndings(input: Buffer): Buffer {
  const capture = input[input.length - 1] === 0x0a ? input.subarray(0, -1) : input
  const extraCarriageReturns = [...capture].reduce(
    (count, byte, index) =>
      count + (byte === 0x0a && capture[index - 1] !== 0x0d ? 1 : 0),
    0,
  )
  if (extraCarriageReturns === 0) return capture

  const output = Buffer.allocUnsafe(capture.length + extraCarriageReturns)
  let writeOffset = 0
  for (let index = 0; index < capture.length; index += 1) {
    const byte = capture[index]
    if (byte === 0x0a && capture[index - 1] !== 0x0d) {
      output[writeOffset] = 0x0d
      writeOffset += 1
    }
    output[writeOffset] = byte
    writeOffset += 1
  }
  return output
}

export function parseControlModeLine(line: Buffer): ControlModeLine {
  const outputPrefix = Buffer.from('%output ')
  if (startsWith(line, outputPrefix)) {
    const paneEnd = line.indexOf(0x20, outputPrefix.length)
    if (paneEnd !== -1) {
      const paneId = line.subarray(outputPrefix.length, paneEnd).toString('ascii')
      if (PANE_ID.test(paneId)) {
        return {
          type: 'output',
          paneId,
          data: decodeControlEscapes(line.subarray(paneEnd + 1)),
        }
      }
    }
  }

  const ascii = line.toString('ascii')
  const guard = /^%(begin|end|error) (\d+ \d+ \d+)$/.exec(ascii)
  if (guard) {
    return {
      type: guard[1] as 'begin' | 'end' | 'error',
      id: guard[2],
    }
  }
  const notificationEnd = line.indexOf(0x20)
  const notification = line
    .subarray(0, notificationEnd === -1 ? line.length : notificationEnd)
    .toString('ascii')
  if (CONTROL_NOTIFICATIONS.has(notification)) {
    return { type: 'notification', data: line }
  }
  return { type: 'data', data: line }
}

export class ControlModeLineBuffer {
  private pending = Buffer.alloc(0)

  constructor(
    private readonly onLine: (line: Buffer) => void,
    private readonly maxLineBytes = MAX_CONTROL_LINE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let input = chunk
    if (this.pending.length > 0) {
      input = Buffer.concat([this.pending, chunk])
      this.pending = Buffer.alloc(0)
    }

    let start = 0
    for (;;) {
      const newline = input.indexOf(0x0a, start)
      if (newline === -1) break
      let end = newline
      if (end > start && input[end - 1] === 0x0d) end -= 1
      if (end - start > this.maxLineBytes) {
        throw new Error('tmux control-mode line exceeded the buffer limit')
      }
      this.onLine(input.subarray(start, end))
      start = newline + 1
    }

    if (start < input.length) {
      const remainder = input.subarray(start)
      if (remainder.length > this.maxLineBytes) {
        throw new Error('tmux control-mode line exceeded the buffer limit')
      }
      this.pending = Buffer.from(remainder)
    }
  }
}

export function encodeLiteralInputCommand(paneId: string, data: string): string | null {
  assertPaneId(paneId)
  if (data.includes('\0')) throw new Error('Input contains a null byte')
  const bytes = Buffer.from(data, 'utf8')
  if (bytes.length === 0) return null
  const hexBytes = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `send-keys -H -t ${paneId} ${hexBytes.join(' ')}`
}

export function encodeSpecialKeyCommand(paneId: string, key: SpecialKey): string {
  assertPaneId(paneId)
  const keyName = KEY_NAMES[key]
  if (!keyName) throw new Error('Unsupported tmux key')
  return `send-keys -t ${paneId} ${keyName}`
}

export function capturePaneProcess(
  socketArgs: readonly string[],
  paneId: string,
  alternate = false,
): Promise<Buffer> {
  assertPaneId(paneId)
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      [
        ...socketArgs,
        'capture-pane',
        '-p',
        '-e',
        '-N',
        '-S',
        `-${TERMINAL_SCROLLBACK_LINES}`,
        ...(alternate ? ['-a'] : []),
        '-t',
        paneId,
      ],
      {
        encoding: null,
        maxBuffer: MAX_CAPTURE_BYTES,
        shell: false,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new TmuxControlCommandError(
              boundedMessage(stderr) ||
                (error.killed ? 'tmux pane capture timed out' : error.message),
            ),
          )
          return
        }
        resolve(stdout)
      },
    )
  })
}

function boundedMessage(data: Buffer): string {
  return data.subarray(0, 2_000).toString('utf8').trim()
}

export async function capturePausedPane<T>(
  paneId: string,
  command: (command: string) => Promise<Buffer>,
  capture: () => Promise<T>,
  deliver: (capture: T) => void | Promise<void>,
): Promise<T> {
  assertPaneId(paneId)
  await command(`refresh-client -A '${paneId}:pause'`)
  try {
    const output = await capture()
    await deliver(output)
    return output
  } finally {
    await command(`refresh-client -A '${paneId}:continue'`)
  }
}

export async function capturePaneSeedProcess(
  socketArgs: readonly string[],
  paneId: string,
  command: (command: string) => Promise<Buffer>,
): Promise<PaneSeedCapture> {
  const readState = async (): Promise<PaneTerminalState> => {
    const output = await command(
      `display-message -p -t ${paneId} -F '${PANE_TERMINAL_STATE_FORMAT}'`,
    )
    const state = parsePaneTerminalState(output.toString('utf8'), paneId)
    if (!state) {
      throw new TmuxControlCommandError('tmux returned invalid pane terminal state')
    }
    return state
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readState()
    const normalCapture = before.alternateOn
      ? await capturePaneProcess(socketArgs, paneId, true)
      : undefined
    const capture = await capturePaneProcess(socketArgs, paneId)
    const after = await readState()
    if (stableTerminalState(before) === stableTerminalState(after)) {
      return { capture, normalCapture, terminalState: after }
    }
  }
  throw new TmuxControlCommandError('tmux pane state changed during capture')
}

function stableTerminalState(state: PaneTerminalState): string {
  const { cursorX: _cursorX, cursorY: _cursorY, ...stable } = state
  return JSON.stringify(stable)
}

class TmuxSessionController {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly lineBuffer: ControlModeLineBuffer
  private readonly queue: CommandRequest[] = []
  private active: CommandRequest | null = null
  private block: CommandBlock | null = null
  private attached = false
  private closed = false
  private intentionalClose = false
  private stderr = Buffer.alloc(0)
  private readySettled = false
  private readonly readyPromise: Promise<void>
  private readonly attachTimer: NodeJS.Timeout
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(
    readonly sessionId: string,
    socketArgs: readonly string[],
    private readonly onOutput: (paneId: string, data: Buffer) => void,
    private readonly onNotification: (notification: string) => void,
    private readonly onExit: (error: Error, intentional: boolean) => void,
  ) {
    assertSessionId(sessionId)
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    this.lineBuffer = new ControlModeLineBuffer((line) => this.handleLine(line))
    this.process = spawn(
      'tmux',
      [...socketArgs, '-C', 'attach-session', '-f', 'ignore-size', '-t', sessionId],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    this.process.stdout.on('data', (chunk: Buffer) => {
      try {
        this.lineBuffer.push(chunk)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.process.stderr.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([this.stderr, chunk])
      this.stderr = combined.subarray(Math.max(0, combined.length - 2_000))
    })
    this.process.once('error', (error) => this.fail(error))
    this.process.once('exit', (code, signal) => {
      const detail = boundedMessage(this.stderr)
      const suffix = detail ? `: ${detail}` : ''
      this.fail(
        new Error(
          `tmux control-mode client exited (${signal ?? code ?? 'unknown'})${suffix}`,
        ),
      )
    })
    this.attachTimer = setTimeout(() => {
      this.fail(new Error('tmux control-mode attach timed out'))
    }, ATTACH_TIMEOUT_MS)
    this.attachTimer.unref()
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  command(command: string, maxResponseBytes = 64 * 1024): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('tmux controller is not running'))
    if (this.queue.length >= MAX_COMMAND_QUEUE) {
      return Promise.reject(new Error('tmux controller command queue is full'))
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ command, maxResponseBytes, resolve, reject })
      this.dispatch()
    })
  }

  stop(): void {
    if (this.closed) return
    this.intentionalClose = true
    this.fail(new Error('tmux controller stopped'))
  }

  private handleLine(line: Buffer): void {
    const parsed = parseControlModeLine(line)
    if (parsed.type === 'output') {
      this.onOutput(parsed.paneId, parsed.data)
      return
    }
    if (parsed.type === 'notification') {
      this.onNotification(parsed.data.toString('utf8'))
      return
    }

    if (parsed.type === 'begin') {
      if (this.block) {
        this.fail(new Error('tmux control-mode response blocks overlapped'))
        return
      }
      this.block = {
        id: parsed.id,
        request: this.attached ? this.active : null,
        chunks: [],
        bytes: 0,
        overflowed: false,
      }
      return
    }

    if (parsed.type === 'end' || parsed.type === 'error') {
      const block = this.block
      if (!block || block.id !== parsed.id) {
        this.fail(new Error('tmux control-mode response guard mismatch'))
        return
      }
      this.block = null

      if (!this.attached) {
        if (parsed.type === 'error') {
          this.fail(new Error('tmux control-mode attach failed'))
          return
        }
        this.attached = true
        clearTimeout(this.attachTimer)
        this.readySettled = true
        this.resolveReady()
        this.dispatch()
        return
      }

      const request = block.request
      if (!request || request !== this.active) {
        this.fail(new Error('tmux control-mode response was not attributed'))
        return
      }
      if (request.timer) clearTimeout(request.timer)
      this.active = null
      const output = Buffer.concat(block.chunks, block.bytes)
      if (block.overflowed) {
        request.reject(new Error('tmux command response exceeded the buffer limit'))
      } else if (parsed.type === 'error') {
        request.reject(
          new TmuxControlCommandError(boundedMessage(output) || 'tmux command failed'),
        )
      } else {
        request.resolve(output)
      }
      this.dispatch()
      return
    }

    if (parsed.type !== 'data') return
    if (!this.block) return
    const nextBytes = this.block.bytes + parsed.data.length + 1
    if (nextBytes > (this.block.request?.maxResponseBytes ?? 64 * 1024)) {
      this.block.overflowed = true
      return
    }
    this.block.chunks.push(parsed.data, Buffer.from('\n'))
    this.block.bytes = nextBytes
  }

  private dispatch(): void {
    if (!this.attached || this.active || this.closed) return
    const request = this.queue.shift()
    if (!request) return
    this.active = request
    request.timer = setTimeout(() => {
      this.fail(new Error('tmux control-mode command timed out'))
    }, COMMAND_TIMEOUT_MS)
    request.timer.unref()
    this.process.stdin.write(`${request.command}\n`, (error) => {
      if (error) this.fail(error)
    })
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.attachTimer)
    if (!this.readySettled) {
      this.readySettled = true
      this.rejectReady(error)
    }
    if (this.active?.timer) clearTimeout(this.active.timer)
    this.active?.reject(error)
    this.active = null
    for (const request of this.queue.splice(0)) request.reject(error)
    this.process.kill('SIGTERM')
    this.onExit(error, this.intentionalClose)
  }
}

export class TmuxControllerPool {
  private readonly records = new Map<string, ControllerRecord>()
  private readonly captureTasks = new Map<string, Promise<unknown>>()
  private requiredSessions = new Set<string>()
  private handlers: TmuxControllerHandlers = {}
  private closed = false

  constructor(private readonly socketArgs: readonly string[]) {}

  setHandlers(handlers: TmuxControllerHandlers): void {
    this.handlers = handlers
  }

  setRequiredSessions(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of sessionIds) assertSessionId(sessionId)
    this.requiredSessions = new Set(sessionIds)

    for (const [sessionId, record] of this.records) {
      if (!this.requiredSessions.has(sessionId) && record.leases === 0) {
        this.removeRecord(record)
      }
    }
    for (const sessionId of this.requiredSessions) {
      const record = this.getRecord(sessionId)
      void this.ensureController(record).catch(() => undefined)
    }
  }

  capturePane(sessionId: string, paneId: string): Promise<Buffer> {
    assertSessionId(sessionId)
    assertPaneId(paneId)
    if (this.closed) return Promise.reject(new Error('tmux controller pool is closed'))
    return capturePaneProcess(this.socketArgs, paneId)
  }

  capturePaneSeed(
    sessionId: string,
    paneId: string,
    deliver: (capture: PaneSeedCapture) => void | Promise<void>,
  ): Promise<PaneSeedCapture> {
    assertSessionId(sessionId)
    assertPaneId(paneId)
    const key = `${sessionId}:${paneId}`
    return this.serializeCapture(key, () =>
      this.withController(sessionId, (controller) =>
        capturePausedPane(
          paneId,
          (command) => controller.command(command),
          () =>
            capturePaneSeedProcess(this.socketArgs, paneId, (command) =>
              controller.command(command),
            ),
          deliver,
        ),
      ),
    )
  }

  async sendText(sessionId: string, paneId: string, data: string): Promise<void> {
    const command = encodeLiteralInputCommand(paneId, data)
    if (!command) return
    await this.execute(sessionId, command, 64 * 1024)
  }

  async sendKey(sessionId: string, paneId: string, key: SpecialKey): Promise<void> {
    await this.execute(sessionId, encodeSpecialKeyCommand(paneId, key), 64 * 1024)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.requiredSessions.clear()
    for (const record of [...this.records.values()]) this.removeRecord(record)
  }

  private async execute(
    sessionId: string,
    command: string,
    maxResponseBytes: number,
  ): Promise<Buffer> {
    return this.withController(sessionId, (controller) =>
      controller.command(command, maxResponseBytes),
    )
  }

  private async withController<T>(
    sessionId: string,
    action: (controller: TmuxSessionController) => Promise<T>,
  ): Promise<T> {
    assertSessionId(sessionId)
    if (this.closed) throw new Error('tmux controller pool is closed')
    const record = this.getRecord(sessionId)
    record.leases += 1
    try {
      const controller = await this.ensureController(record)
      return await action(controller)
    } finally {
      record.leases -= 1
      if (!this.requiredSessions.has(sessionId) && record.leases === 0) {
        this.removeRecord(record)
      }
    }
  }

  private serializeCapture<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.captureTasks.get(key)
    const task = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(
      action,
    )
    this.captureTasks.set(key, task)
    void task
      .finally(() => {
        if (this.captureTasks.get(key) === task) this.captureTasks.delete(key)
      })
      .catch(() => undefined)
    return task
  }

  private getRecord(sessionId: string): ControllerRecord {
    assertSessionId(sessionId)
    const existing = this.records.get(sessionId)
    if (existing) return existing
    const record: ControllerRecord = {
      sessionId,
      leases: 0,
      generation: 0,
      restartAttempts: 0,
      restartNotBefore: 0,
    }
    this.records.set(sessionId, record)
    return record
  }

  private ensureController(record: ControllerRecord): Promise<TmuxSessionController> {
    if (record.controller) return Promise.resolve(record.controller)
    if (record.startPromise) return record.startPromise

    const generation = record.generation
    const startPromise = (async () => {
      const delay = Math.max(0, record.restartNotBefore - Date.now())
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          timer.unref()
        })
      }
      if (
        this.closed ||
        this.records.get(record.sessionId) !== record ||
        record.generation !== generation ||
        (!this.requiredSessions.has(record.sessionId) && record.leases === 0)
      ) {
        throw new Error('tmux controller is no longer required')
      }

      const controller = new TmuxSessionController(
        record.sessionId,
        this.socketArgs,
        (paneId, data) => this.handlers.onOutput?.(record.sessionId, paneId, data),
        (notification) => this.handlers.onNotification?.(record.sessionId, notification),
        (error, intentional) => this.controllerExited(record, controller, error, intentional),
      )
      record.controller = controller
      await controller.ready()
      record.restartNotBefore = 0
      if (record.stableTimer) clearTimeout(record.stableTimer)
      record.stableTimer = setTimeout(() => {
        record.restartAttempts = 0
      }, STABLE_CONTROLLER_MS)
      record.stableTimer.unref()
      this.handlers.onReady?.(record.sessionId)
      return controller
    })()

    record.startPromise = startPromise
    void startPromise
      .finally(() => {
        if (record.startPromise === startPromise) record.startPromise = undefined
        if (
          !record.controller &&
          !this.closed &&
          this.records.get(record.sessionId) === record &&
          (this.requiredSessions.has(record.sessionId) || record.leases > 0)
        ) {
          void this.ensureController(record).catch(() => undefined)
        }
      })
      .catch(() => undefined)
    return startPromise
  }

  private controllerExited(
    record: ControllerRecord,
    controller: TmuxSessionController,
    error: Error,
    intentional: boolean,
  ): void {
    if (record.controller !== controller) return
    record.controller = undefined
    if (record.stableTimer) clearTimeout(record.stableTimer)
    record.stableTimer = undefined
    if (intentional || this.closed || this.records.get(record.sessionId) !== record) {
      return
    }

    const delay = RESTART_DELAYS_MS[
      Math.min(record.restartAttempts, RESTART_DELAYS_MS.length - 1)
    ]
    record.restartAttempts += 1
    record.restartNotBefore = Date.now() + delay
    this.handlers.onError?.(record.sessionId, error)
    if (
      !record.startPromise &&
      (this.requiredSessions.has(record.sessionId) || record.leases > 0)
    ) {
      void this.ensureController(record).catch(() => undefined)
    }
  }

  private removeRecord(record: ControllerRecord): void {
    if (this.records.get(record.sessionId) !== record) return
    this.records.delete(record.sessionId)
    record.generation += 1
    if (record.stableTimer) clearTimeout(record.stableTimer)
    record.controller?.stop()
    record.controller = undefined
  }
}
