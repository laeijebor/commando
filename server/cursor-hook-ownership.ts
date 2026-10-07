import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

export type CursorHookAssociation = {
  version: 1
  socketPath: string
  socketDevice: string
  socketInode: string
  serverPid: number
  serverStarted: string
  panePid: number
  paneStarted: string
  producerPid: number
  producerStarted: string
  hookPid: number
  hookStarted: string
}
export type CursorOwnershipIO = {
  run: (command: string, args: string[]) => Promise<string>
  socket: (path: string) => Promise<{ path: string; device: string; inode: string } | null>
  executable: (command: string) => Promise<string | null>
}

/** Embedded in the installed bridge. argv stays local; only process identities leave it. */
export async function discoverCursorAssociation(
  paneId: string,
  socketArgs: string[],
  hookPid: number | null,
  expected: CursorHookAssociation | null,
  io: CursorOwnershipIO,
): Promise<CursorHookAssociation | null> {
  const deadline = Date.now() + 2_500
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('Cursor ownership deadline exceeded')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor ownership deadline exceeded')), remaining)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  try {
    if (!/^%\d+$/.test(paneId)) return null
    // tmux sanitizes control characters differently across client environments.
    // Use a printable separator and peel off the numeric suffix greedily: the
    // socket path itself may contain separators, including numeric-looking ones.
    const fields = /^([\s\S]+)\|(\d+)\|(\d+)$/.exec((await bounded(() => io.run('tmux', [...socketArgs,
      'display-message', '-p', '-t', paneId, '#{socket_path}|#{pid}|#{pane_pid}']))).trimEnd())
    if (!fields) return null
    const socket = await bounded(() => io.socket(fields[1]))
    const serverPid = Number(fields[2])
    const panePid = Number(fields[3])
    if (!socket || !Number.isSafeInteger(serverPid) || !Number.isSafeInteger(panePid)) return null
    // lstart is a birth identity, not a callback ordering clock. Recheck ancestry and
    // foreground group on every read, including after a hook has exited.
    const rows = await bounded(() => io.run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,tpgid=,lstart=,command=']))
    const processes = new Map<number, { pid: number; ppid: number; pgid: number; foreground: number; started: string; command: string }>()
    for (const line of rows.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line)
      if (!match) continue
      const pid = Number(match[1])
      processes.set(pid, { pid, ppid: Number(match[2]), pgid: Number(match[3]), foreground: Number(match[4]), started: match[5].replace(/\s+/g, ' '), command: match[6] })
    }
    const server = processes.get(serverPid)
    const pane = processes.get(panePid)
    const hook = hookPid === null ? null : processes.get(hookPid)
    if (!server || !pane || (hookPid !== null && !hook)) return null
    const ancestors = (pid: number): number[] => {
      const result: number[] = []
      for (let current = processes.get(pid); current && result.length < 128; current = processes.get(current.ppid)) {
        if (result.includes(current.pid)) return []
        result.push(current.pid)
      }
      return result
    }
    const candidates = hook ? ancestors(hook.ppid) : expected ? [expected.producerPid] : [...processes.keys()]
    let producer: typeof pane | undefined
    for (const pid of candidates) {
      const candidate = processes.get(pid)
      if (!candidate || !ancestors(pid).includes(panePid) || candidate.pgid <= 0 ||
        candidate.pgid !== pane.foreground || candidate.foreground !== candidate.pgid) continue
      // comm is PID-scoped executable evidence. command is flattened by ps,
      // so recover complete known path suffixes and verify them on disk rather
      // than guessing argv boundaries from whitespace in installation paths.
      const executable = (await bounded(() => io.run('/bin/ps', ['-p', String(pid), '-o', 'comm=']))).trimEnd()
      const runtime = /(?:^|\/)(?:node|bun|deno)$/.test(executable)
      const invocation = /^([\s\S]+?\/(?:node|bun|deno|agent|cursor-agent)|node|bun|deno|agent|cursor-agent)\s+(?:--use-system-ca\s+)?([\s\S]+?\/cursor-agent\/(?:versions\/[^/]+\/)?index\.js)(?=\s|$)/.exec(candidate.command)
      let supported = false
      if (runtime && invocation) {
        const alias = await bounded(() => io.executable(invocation[1]))
        const script = await bounded(() => io.executable(invocation[2]))
        const runtimeAlias = alias !== null && /(?:^|\/)(?:node|bun|deno)$/.test(alias)
        const cursorAlias = alias !== null && (/(?:^|\/)cursor-agent$/.test(alias) ||
          /(?:^|\/)cursor-agent\/(?:versions\/[^/]+\/)?agent$/.test(alias))
        supported = (runtimeAlias || cursorAlias) && script !== null &&
          /(?:^|\/)cursor-agent\/(?:versions\/[^/]+\/)?index\.js$/.test(script)
      } else if (/(?:^|\/)(?:agent|cursor-agent)$/.test(executable)) {
        const commandPath = /^([\s\S]+?\/(?:agent|cursor-agent)|agent|cursor-agent)(?=\s|$)/.exec(candidate.command)?.[1]
        const resolved = commandPath ? await bounded(() => io.executable(commandPath)) : null
        supported = resolved !== null && (/(?:^|\/)cursor-agent$/.test(resolved) ||
          /(?:^|\/)cursor-agent\/(?:versions\/[^/]+\/)?agent$/.test(resolved))
      }
      if (supported) { producer = candidate; break }
    }
    if (!producer) return null
    const association: CursorHookAssociation = {
      version: 1, socketPath: socket.path, socketDevice: socket.device, socketInode: socket.inode,
      serverPid, serverStarted: server.started, panePid, paneStarted: pane.started,
      producerPid: producer.pid, producerStarted: producer.started,
      hookPid: hook?.pid ?? expected?.hookPid ?? producer.pid, hookStarted: hook?.started ?? expected?.hookStarted ?? producer.started,
    }
    if (expected && Object.keys(association).some((key) =>
      association[key as keyof CursorHookAssociation] !== expected[key as keyof CursorHookAssociation])) return null
    return association
  } catch { return null }
}

const execute = promisify(execFile)
export const cursorOwnershipIO: CursorOwnershipIO = {
  run: async (command, args) => (await execute(command, args, {
    timeout: 750, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  })).stdout,
  socket: async (path) => {
    const resolved = await realpath(path)
    const metadata = await stat(resolved, { bigint: true })
    return metadata.isSocket() ? { path: resolved, device: String(metadata.dev), inode: String(metadata.ino) } : null
  },
  executable: async (command) => {
    for (const path of command.includes('/') ? [command] : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, command))) {
      try { return await realpath(path) } catch { /* next PATH entry */ }
    }
    return null
  },
}

export function localCursorSocketArgs(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const path = env.COMMANDO_TMUX_SOCKET_PATH
  const name = env.COMMANDO_TMUX_SOCKET_NAME
  if (path && name) return null
  if (path) return path.startsWith('/') && !path.includes('\0') ? ['-S', path] : null
  if (name) return /^[A-Za-z0-9_.-]{1,128}$/.test(name) ? ['-L', name] : null
  return []
}

export async function verifyCursorHookAssociation(paneId: string, body: Record<string, unknown>, options: { socketArgs?: string[] | null; io?: CursorOwnershipIO; now?: bigint } = {}): Promise<CursorHookAssociation | null> {
  const expected = body.association as CursorHookAssociation | undefined
  const args = options.socketArgs === undefined ? localCursorSocketArgs() : options.socketArgs
  if (!args || !expected || expected.version !== 1 || !Number.isSafeInteger(expected.hookPid)) return null
  // The emission clock is captured before stdin/network I/O, on this host's monotonic clock.
  const emitted = body.emittedAt
  const now = options.now ?? process.hrtime.bigint()
  if (typeof emitted !== 'string' || !/^\d{1,22}$/.test(emitted) || BigInt(emitted) > now || now - BigInt(emitted) > 30_000_000_000n) return null
  return discoverCursorAssociation(paneId, args, expected.hookPid, expected, options.io ?? cursorOwnershipIO)
}

export async function cursorAssociationIsCurrent(paneId: string, association: CursorHookAssociation): Promise<boolean> {
  const args = localCursorSocketArgs()
  return args !== null && await discoverCursorAssociation(paneId, args, null, association, cursorOwnershipIO) !== null
}

export function cursorProducerIdentity(association: CursorHookAssociation): string {
  const { hookPid: _hookPid, hookStarted: _hookStarted, ...producer } = association
  return JSON.stringify(producer)
}

export async function cursorForegroundIsCurrent(paneId: string): Promise<boolean> {
  const args = localCursorSocketArgs()
  return args !== null && await discoverCursorAssociation(paneId, args, null, null, cursorOwnershipIO) !== null
}
