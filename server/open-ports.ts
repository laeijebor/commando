import { execFile } from 'node:child_process'
import type { OpenPort } from '../shared/protocol.js'
import type { TmuxPaneProcess } from './tmux-parsers.js'

const SCAN_INTERVAL_MS = 2_000
const COMMAND_TIMEOUT_MS = 1_500
const COMMAND_BUFFER_BYTES = 4 * 1024 * 1024

export type ListeningProcess = {
  processId: number
  processName: string
  port: number
}

export type ManagedOpenPort = OpenPort & {
  processId: number
}

export type OpenPortTarget = Pick<OpenPort, 'sessionId' | 'paneId' | 'port'>

export type TerminatedSessionPorts = {
  processCount: number
  portCount: number
}

export type OpenPortCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>

export type ProcessSignaler = (processId: number, signal: NodeJS.Signals) => void

export class OpenPortNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenPortNotFoundError'
  }
}

function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], {
      encoding: 'utf8',
      maxBuffer: COMMAND_BUFFER_BYTES,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (!error || (command === 'lsof' && error.code === 1 && stdout.length === 0)) {
        resolve(stdout)
        return
      }
      reject(error)
    })
  })
}

export function parseListeningProcesses(output: string): ListeningProcess[] {
  const listeners: ListeningProcess[] = []
  let processId: number | null = null
  let processName = ''

  for (const line of output.split(/\r?\n/)) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      processId = /^\d+$/.test(value) ? Number(value) : null
      processName = ''
    } else if (field === 'c' && processId !== null) {
      processName = value
    } else if (field === 'n' && processId !== null) {
      const match = /:(\d+)$/.exec(value)
      const port = Number(match?.[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
        listeners.push({ processId, processName: processName || 'process', port })
      }
    }
  }

  return listeners
}

export function parseProcessParents(output: string): Map<number, number> {
  const parents = new Map<number, number>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

export function associateManagedPortsWithPanes(
  listeners: ListeningProcess[],
  parents: ReadonlyMap<number, number>,
  panes: TmuxPaneProcess[],
): ManagedOpenPort[] {
  const paneByProcess = new Map(panes.map((pane) => [pane.processId, pane]))
  const ports = new Map<string, ManagedOpenPort>()

  for (const listener of listeners) {
    let processId: number | undefined = listener.processId
    const visited = new Set<number>()
    let pane: TmuxPaneProcess | undefined
    while (processId !== undefined && processId > 0 && !visited.has(processId)) {
      pane = paneByProcess.get(processId)
      if (pane) break
      visited.add(processId)
      processId = parents.get(processId)
    }
    if (!pane) continue

    const key = `${pane.sessionId}\u0000${pane.paneId}\u0000${listener.port}`
    if (!ports.has(key)) {
      ports.set(key, {
        port: listener.port,
        processName: listener.processName,
        sessionId: pane.sessionId,
        paneId: pane.paneId,
        processId: listener.processId,
      })
    }
  }

  return [...ports.values()].sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId) || left.port - right.port,
  )
}

function publicPort({ processId: _processId, ...port }: ManagedOpenPort): OpenPort {
  return port
}

export function associatePortsWithPanes(
  listeners: ListeningProcess[],
  parents: ReadonlyMap<number, number>,
  panes: TmuxPaneProcess[],
): OpenPort[] {
  return associateManagedPortsWithPanes(listeners, parents, panes).map(publicPort)
}

async function discoverManagedOpenPorts(
  panes: TmuxPaneProcess[],
  runner: OpenPortCommandRunner,
): Promise<ManagedOpenPort[]> {
  const [listeners, processes] = await Promise.all([
    runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
    runner('ps', ['-axo', 'pid=,ppid=']),
  ])
  return associateManagedPortsWithPanes(
    parseListeningProcesses(listeners),
    parseProcessParents(processes),
    panes,
  )
}

export async function discoverOpenPorts(
  panes: TmuxPaneProcess[],
  runner: OpenPortCommandRunner = runCommand,
): Promise<OpenPort[]> {
  return (await discoverManagedOpenPorts(panes, runner)).map(publicPort)
}

export class OpenPortScanner {
  private ports: OpenPort[] = []
  private scannedAt = 0
  private paneSignature = ''

  constructor(
    private readonly runner: OpenPortCommandRunner = runCommand,
    private readonly signaler: ProcessSignaler = (processId, signal) => process.kill(processId, signal),
  ) {}

  async scan(panes: TmuxPaneProcess[], capturedAt = Date.now()): Promise<OpenPort[]> {
    const paneIds = new Set(panes.map((pane) => pane.paneId))
    const currentPorts = () => this.ports.filter((port) => paneIds.has(port.paneId))
    const paneSignature = panes
      .map((pane) => `${pane.paneId}:${pane.processId}`)
      .sort()
      .join('|')
    if (
      paneSignature === this.paneSignature &&
      capturedAt - this.scannedAt < SCAN_INTERVAL_MS
    ) {
      return currentPorts()
    }

    if (paneSignature !== this.paneSignature) this.ports = []
    try {
      this.ports = await discoverOpenPorts(panes, this.runner)
      this.scannedAt = capturedAt
      this.paneSignature = paneSignature
    } catch {
      // Port discovery is optional on hosts without lsof or process visibility.
    }
    return currentPorts()
  }

  async terminatePort(panes: TmuxPaneProcess[], target: OpenPortTarget): Promise<OpenPort> {
    const ports = await discoverManagedOpenPorts(panes, this.runner)
    const match = ports.find((port) =>
      port.sessionId === target.sessionId &&
      port.paneId === target.paneId &&
      port.port === target.port,
    )
    if (!match) throw new OpenPortNotFoundError('Open port process no longer exists')

    try {
      this.signaler(match.processId, 'SIGTERM')
    } finally {
      this.invalidate()
    }
    return publicPort(match)
  }

  async terminateSessionPorts(
    panes: TmuxPaneProcess[],
    sessionId: string,
  ): Promise<TerminatedSessionPorts> {
    const ports = (await discoverManagedOpenPorts(panes, this.runner))
      .filter((port) => port.sessionId === sessionId)
    if (ports.length === 0) {
      throw new OpenPortNotFoundError('No open port processes remain for this session')
    }

    const processIds = [...new Set(ports.map((port) => port.processId))]
    try {
      for (const processId of processIds) this.signaler(processId, 'SIGTERM')
    } finally {
      this.invalidate()
    }
    return { processCount: processIds.length, portCount: ports.length }
  }

  private invalidate(): void {
    this.ports = []
    this.scannedAt = 0
    this.paneSignature = ''
  }
}
