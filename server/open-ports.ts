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

export type OpenPortCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>

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

export function associatePortsWithPanes(
  listeners: ListeningProcess[],
  parents: ReadonlyMap<number, number>,
  panes: TmuxPaneProcess[],
): OpenPort[] {
  const paneByProcess = new Map(panes.map((pane) => [pane.processId, pane]))
  const ports = new Map<string, OpenPort>()

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
      })
    }
  }

  return [...ports.values()].sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId) || left.port - right.port,
  )
}

export async function discoverOpenPorts(
  panes: TmuxPaneProcess[],
  runner: OpenPortCommandRunner = runCommand,
): Promise<OpenPort[]> {
  const [listeners, processes] = await Promise.all([
    runner('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
    runner('ps', ['-axo', 'pid=,ppid=']),
  ])
  return associatePortsWithPanes(
    parseListeningProcesses(listeners),
    parseProcessParents(processes),
    panes,
  )
}

export class OpenPortScanner {
  private ports: OpenPort[] = []
  private scannedAt = 0
  private paneSignature = ''

  constructor(private readonly runner: OpenPortCommandRunner = runCommand) {}

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
}
