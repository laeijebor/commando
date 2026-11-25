import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreciseNavUnavailable, type PreciseQuery } from './code-nav-provider.js'
import {
  HUNG_MESSAGE,
  LOADING_MESSAGE,
  resolveTsServer,
  STOPPED_MESSAGE,
  TsServerMessageReader,
  TypeScriptNavProvider,
  type TsServerMessage,
  type TsServerProcess,
  type TypeScriptNavOptions,
} from './code-nav-tsserver.js'

function frame(message: unknown): Buffer {
  const json = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'ascii'), json])
}

type Request = { seq: number; command: string; arguments: Record<string, unknown> }
const HOLD = Symbol('hold')
type Handler = (request: Request) => unknown

let nextPid = 1000

class FakeTsServer extends EventEmitter implements TsServerProcess {
  readonly pid = nextPid++
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly requests: Request[] = []
  readonly signals: NodeJS.Signals[] = []
  exited = false
  /** Exit when sent SIGTERM; off simulates a server that ignores it. */
  exitOnTerm = true

  constructor(public handler: Handler | undefined) {
    super()
    let buffered = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffered.slice(0, newline)) as Request
        buffered = buffered.slice(newline + 1)
        this.requests.push(request)
        const body = this.handler?.(request)
        if (body !== HOLD) this.reply(request.seq, body)
      }
    })
  }

  reply(seq: number, body: unknown, success = true, message?: string): void {
    this.stdout.write(frame({ seq: 0, type: 'response', request_seq: seq, success, message, body }))
  }

  event(name: string): void {
    this.stdout.write(frame({ seq: 0, type: 'event', event: name, body: {} }))
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || this.exitOnTerm) this.exit(null, signal)
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    queueMicrotask(() => this.emit('exit', code, signal))
  }

  commands(): string[] {
    return this.requests.map((request) => request.command)
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => process.nextTick(resolve))
}

const span = (line: number, offset: number, endOffset: number) => ({
  start: { line, offset },
  end: { line, offset: endOffset },
})

/** Answers every command with canned bodies unless a test overrides one. */
function cannedHandler(overrides: Record<string, (request: Request) => unknown> = {}): Handler {
  return (request) => {
    const override = overrides[request.command]
    if (override) return override(request)
    if (request.command === 'updateOpen') return true
    if (request.command === 'definition') return [{ file: '/repo/a.ts', ...span(3, 17, 22) }]
    return undefined
  }
}

function setup(options: TypeScriptNavOptions = {}, handler: () => Handler = () => cannedHandler()) {
  const spawned: { server: FakeTsServer; command: string; args: readonly string[]; cwd: string }[] = []
  const files = new Map<string, string>([
    ['/repo/b.ts', 'import { greet } from "./a"\ngreet("x")\n'],
    ['/repo/c.ts', 'export const c = 1\n'],
  ])
  const provider = new TypeScriptNavProvider({
    resolveServer: (root) => `${root}/node_modules/typescript/lib/tsserver.js`,
    readFile: async (path) => {
      const content = files.get(path) ?? files.get(path.replace(/^\/[^/]+/, '/repo'))
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    spawn: (command, args, { cwd }) => {
      const server = new FakeTsServer(handler())
      spawned.push({ server, command, args, cwd })
      return server
    },
    ...options,
  })
  return { provider, spawned, files }
}

const query = (overrides: Partial<PreciseQuery> = {}): PreciseQuery => ({
  root: '/repo',
  kind: 'definition',
  path: '/repo/b.ts',
  line: 2,
  character: 0,
  ...overrides,
})

describe('TsServerMessageReader', () => {
  it('reassembles messages split at every byte, including inside multi-byte characters', () => {
    const messages = [
      { type: 'response', request_seq: 1, body: { text: 'héllo — 🎉 naïve' } },
      { type: 'event', event: 'projectLoadingStart' },
      { type: 'response', request_seq: 2, body: ['日本語'] },
    ]
    const bytes = Buffer.concat(messages.map(frame))
    for (let split = 1; split < bytes.length; split++) {
      const received: TsServerMessage[] = []
      const reader = new TsServerMessageReader((message) => received.push(message))
      reader.push(bytes.subarray(0, split))
      reader.push(bytes.subarray(split))
      expect(received).toEqual(messages)
    }
  })

  it('handles one byte at a time and skips headers without a length', () => {
    const received: TsServerMessage[] = []
    const reader = new TsServerMessageReader((message) => received.push(message))
    const bytes = Buffer.concat([Buffer.from('X-Junk: 1\r\n\r\n'), frame({ type: 'response', request_seq: 7 })])
    for (const byte of bytes) reader.push(Buffer.from([byte]))
    expect(received).toEqual([{ type: 'response', request_seq: 7 }])
  })
})

describe('TypeScriptNavProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles TypeScript and JavaScript files', () => {
    const { provider } = setup()
    for (const path of ['a.ts', 'a.tsx', 'a.d.ts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts', 'A.TS']) {
      expect(provider.handles(`src/${path}`)).toBe(true)
    }
    for (const path of ['a.py', 'a.json', 'a.tsbuildinfo', 'ts']) expect(provider.handles(path)).toBe(false)
  })

  it('spawns tsserver with node in the root and opens the file from disk before each query', async () => {
    const { provider, spawned, files } = setup()
    const result = await provider.query(query({ line: 2, character: 4 }))
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe(process.execPath)
    expect(spawned[0].args[0]).toBe('/repo/node_modules/typescript/lib/tsserver.js')
    expect(spawned[0].args).toContain('--disableAutomaticTypingAcquisition')
    expect(spawned[0].args).toContain('--suppressDiagnosticEvents')
    expect(spawned[0].cwd).toBe('/repo')

    const [open, definition] = spawned[0].server.requests
    expect(open).toMatchObject({
      command: 'updateOpen',
      arguments: {
        openFiles: [{ file: '/repo/b.ts', fileContent: files.get('/repo/b.ts'), projectRootPath: '/repo' }],
        closedFiles: [],
      },
    })
    // tsserver offsets are 1-based; ours are 0-based.
    expect(definition).toMatchObject({ command: 'definition', arguments: { file: '/repo/b.ts', line: 2, offset: 5 } })
    expect(result).toEqual([{ path: '/repo/a.ts', line: 3, character: 16, endLine: 3, endCharacter: 21 }])

    // An edit on disk is sent with the next query; another file replaces the open one.
    files.set('/repo/b.ts', 'edited\n')
    await provider.query(query())
    expect(spawned[0].server.requests[2].arguments).toMatchObject({
      openFiles: [{ file: '/repo/b.ts', fileContent: 'edited\n' }],
      closedFiles: [],
    })
    await provider.query(query({ path: '/repo/c.ts' }))
    expect(spawned[0].server.requests[4].arguments).toMatchObject({
      openFiles: [{ file: '/repo/c.ts' }],
      closedFiles: ['/repo/b.ts'],
    })
    expect(spawned).toHaveLength(1)
    await provider.dispose()
  })

  it('correlates by request_seq across events and responses nobody waits for', async () => {
    const { provider, spawned } = setup({}, () => (request) => (request.command === 'updateOpen' ? true : HOLD))
    const pending = provider.query(query())
    await settle()
    const server = spawned[0].server
    const definition = server.requests.find((request) => request.command === 'definition')!
    server.event('projectLoadingFinish')
    server.reply(definition.seq + 50, [{ file: '/wrong.ts', ...span(1, 1, 2) }])
    server.reply(definition.seq, [{ file: '/repo/a.ts', ...span(1, 17, 22) }])
    await expect(pending).resolves.toEqual([{ path: '/repo/a.ts', line: 1, character: 16, endLine: 1, endCharacter: 21 }])
    await provider.dispose()
  })

  it('maps references with their line text', async () => {
    const { provider, spawned } = setup({}, () =>
      cannedHandler({
        references: () => ({
          refs: [
            { file: '/repo/a.ts', ...span(1, 17, 22), lineText: 'export function greet() {}', isDefinition: true },
            { file: '/repo/b.ts', ...span(2, 1, 6), lineText: 'greet("x")', isDefinition: false },
          ],
          symbolName: 'greet',
        }),
      }),
    )
    const result = await provider.query(query({ kind: 'references', character: 0 }))
    expect(spawned[0].server.commands()).toEqual(['updateOpen', 'references'])
    expect(result).toEqual([
      { path: '/repo/a.ts', line: 1, character: 16, endLine: 1, endCharacter: 21, preview: 'export function greet() {}' },
      { path: '/repo/b.ts', line: 2, character: 0, endLine: 2, endCharacter: 5, preview: 'greet("x")' },
    ])
    await provider.dispose()
  })

  it('maps callers from every call hierarchy item, one location per call site', async () => {
    const { provider, spawned } = setup({}, () =>
      cannedHandler({
        prepareCallHierarchy: () => [
          { name: 'greet', file: '/repo/a.ts', selectionSpan: span(1, 17, 22) },
          { name: 'greet', file: '/repo/a.d.ts', selectionSpan: span(4, 3, 8) },
        ],
        provideCallHierarchyIncomingCalls: (request) =>
          request.arguments.file === '/repo/a.ts'
            ? [
                { from: { name: 'first', file: '/repo/b.ts' }, fromSpans: [span(3, 10, 15), span(4, 10, 15)] },
                { from: { name: 'second', file: '/repo/c.ts' }, fromSpans: [span(9, 3, 8)] },
              ]
            : [],
      }),
    )
    const result = await provider.query(query({ kind: 'callers' }))
    const server = spawned[0].server
    expect(server.commands()).toEqual([
      'updateOpen',
      'prepareCallHierarchy',
      'provideCallHierarchyIncomingCalls',
      'provideCallHierarchyIncomingCalls',
    ])
    expect(server.requests[2].arguments).toEqual({ file: '/repo/a.ts', line: 1, offset: 17 })
    expect(server.requests[3].arguments).toEqual({ file: '/repo/a.d.ts', line: 4, offset: 3 })
    expect(result).toEqual([
      { path: '/repo/b.ts', line: 3, character: 9, endLine: 3, endCharacter: 14, container: 'first' },
      { path: '/repo/b.ts', line: 4, character: 9, endLine: 4, endCharacter: 14, container: 'first' },
      { path: '/repo/c.ts', line: 9, character: 2, endLine: 9, endCharacter: 7, container: 'second' },
    ])
    await provider.dispose()
  })

  it('treats "No content available." as no results and other failures as unavailable', async () => {
    let failure = 'No content available.'
    const { provider, spawned } = setup({}, () =>
      cannedHandler({
        prepareCallHierarchy: (request) => {
          spawned[0].server.reply(request.seq, undefined, false, failure)
          return HOLD
        },
      }),
    )
    await expect(provider.query(query({ kind: 'callers' }))).resolves.toEqual([])
    failure = 'No Project.'
    const rejected = provider.query(query({ kind: 'callers' }))
    await expect(rejected).rejects.toBeInstanceOf(PreciseNavUnavailable)
    await expect(rejected).rejects.toThrow('TypeScript server error: No Project.')
    await provider.dispose()
  })

  it('rejects as unavailable when the file cannot be read', async () => {
    const { provider } = setup()
    await expect(provider.query(query({ path: '/repo/missing.ts' }))).rejects.toBeInstanceOf(PreciseNavUnavailable)
    await provider.dispose()
  })

  it('runs one server per root and stops the least recently used when a third starts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const { provider, spawned } = setup()
    await provider.query(query({ root: '/a', path: '/a/b.ts' }))
    vi.setSystemTime(2_000)
    await provider.query(query({ root: '/b', path: '/b/b.ts' }))
    vi.setSystemTime(3_000)
    await provider.query(query({ root: '/a', path: '/a/b.ts' }))
    expect(spawned.map((entry) => entry.cwd)).toEqual(['/a', '/b'])

    vi.setSystemTime(4_000)
    await provider.query(query({ root: '/c', path: '/c/b.ts' }))
    expect(spawned.map((entry) => entry.cwd)).toEqual(['/a', '/b', '/c'])
    expect(spawned[1].server.signals).toEqual(['SIGTERM'])
    expect(spawned[0].server.signals).toEqual([])
    expect(provider.stats()).toEqual([
      { root: '/a', pid: spawned[0].server.pid, startedAt: 1_000, lastUsedAt: 3_000 },
      { root: '/c', pid: spawned[2].server.pid, startedAt: 4_000, lastUsedAt: 4_000 },
    ])
    await provider.dispose()
  })

  it('stops an idle server, escalating to SIGKILL, and restarts it on the next query', async () => {
    vi.useFakeTimers()
    const { provider, spawned } = setup({ idleMs: 60_000, killGraceMs: 2_000 })
    await provider.query(query())
    const server = spawned[0].server
    server.exitOnTerm = false

    await vi.advanceTimersByTimeAsync(59_000)
    await provider.query(query()) // resets the idle timer
    await vi.advanceTimersByTimeAsync(59_000)
    expect(server.signals).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.signals).toEqual(['SIGTERM'])
    expect(provider.stats()).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(server.signals).toEqual(['SIGTERM', 'SIGKILL'])

    await provider.query(query())
    expect(spawned).toHaveLength(2)
    await provider.dispose()
  })

  it('rejects in-flight queries when the server crashes and restarts on the next query', async () => {
    const { provider, spawned } = setup({}, () => (request) => (request.command === 'updateOpen' ? true : HOLD))
    const pending = provider.query(query())
    await settle()
    spawned[0].server.exit(1)
    await expect(pending).rejects.toThrow(new PreciseNavUnavailable(STOPPED_MESSAGE))
    expect(provider.stats()).toEqual([])

    spawned.length = 0
    const next = provider.query(query())
    await settle()
    expect(spawned).toHaveLength(1)
    const definition = spawned[0].server.requests.find((request) => request.command === 'definition')!
    spawned[0].server.reply(definition.seq, [])
    await expect(next).resolves.toEqual([])
    await provider.dispose()
  })

  it('times out while loading but keeps the server, ignores the late answer and stays correlated', async () => {
    const { provider, spawned } = setup({ coldTimeoutMs: 40, warmTimeoutMs: 40 }, () => (request) =>
      request.command === 'updateOpen' ? true : HOLD,
    )
    const first = provider.query(query())
    await expect(first).rejects.toThrow(new PreciseNavUnavailable(LOADING_MESSAGE))
    const server = spawned[0].server
    expect(server.signals).toEqual([])
    expect(provider.stats()).toHaveLength(1)

    // A query queued behind the slow one: it times out before running and sends nothing.
    const queued = provider.query(query())
    await expect(queued).rejects.toThrow(LOADING_MESSAGE)
    expect(server.commands()).toEqual(['updateOpen', 'definition'])

    // The slow answer arrives late; the next query gets its own answer, not that one.
    const late = server.requests[1]
    server.reply(late.seq, [{ file: '/repo/late.ts', ...span(1, 1, 2) }])
    await settle()
    const third = provider.query(query())
    await settle()
    const definition = server.requests.at(-1)!
    expect(definition.command).toBe('definition')
    expect(definition.seq).not.toBe(late.seq)
    server.reply(definition.seq, [{ file: '/repo/a.ts', ...span(2, 1, 4) }])
    await expect(third).resolves.toEqual([{ path: '/repo/a.ts', line: 2, character: 0, endLine: 2, endCharacter: 3 }])
    expect(spawned).toHaveLength(1)
    await provider.dispose()
  })

  it('replaces a server whose request never answers once another lookup waits behind it', async () => {
    const { provider, spawned } = setup({ coldTimeoutMs: 40, warmTimeoutMs: 40, hungAfterMs: 60 }, () => (request) =>
      request.command === 'updateOpen' ? true : HOLD,
    )
    await expect(provider.query(query())).rejects.toThrow(LOADING_MESSAGE)
    expect(spawned[0].server.signals).toEqual([])
    // Waiting behind the stuck request past hungAfterMs: the server is stopped, not waited on forever.
    await expect(provider.query(query())).rejects.toThrow(HUNG_MESSAGE)
    expect(spawned[0].server.signals).toEqual(['SIGTERM'])
    expect(provider.stats()).toEqual([])
    // The next lookup starts a fresh server.
    void provider.query(query()).catch(() => undefined)
    await settle()
    expect(spawned).toHaveLength(2)
    await provider.dispose()
  })

  it('uses the cold timeout until the server has answered once', async () => {
    let delay = 60
    const { provider, spawned } = setup({ coldTimeoutMs: 200, warmTimeoutMs: 30 }, () => (request) => {
      if (request.command === 'updateOpen') return true
      setTimeout(() => spawned[0].server.reply(request.seq, []), delay)
      return HOLD
    })
    await expect(provider.query(query())).resolves.toEqual([])
    delay = 60
    await expect(provider.query(query())).rejects.toThrow(LOADING_MESSAGE)
    await provider.dispose()
  })

  it('rejects as unavailable when tsserver cannot be resolved or spawned', async () => {
    const { provider } = setup({
      resolveServer: () => {
        throw new Error("Cannot find module 'typescript/lib/tsserver.js'")
      },
    })
    await expect(provider.query(query())).rejects.toThrow(/Could not start the TypeScript server/)
    expect(provider.stats()).toEqual([])
  })

  it('dispose stops every server and refuses later queries', async () => {
    const { provider, spawned } = setup()
    await provider.query(query({ root: '/a', path: '/a/b.ts' }))
    await provider.query(query({ root: '/b', path: '/b/b.ts' }))
    await provider.dispose()
    expect(spawned.map((entry) => entry.server.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
    expect(spawned.every((entry) => entry.server.stdin.writableEnded)).toBe(true)
    expect(provider.stats()).toEqual([])
    await expect(provider.query(query())).rejects.toBeInstanceOf(PreciseNavUnavailable)
  })
})

describe('resolveTsServer', () => {
  it("runs the daemon's TypeScript, never a project's own copy", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'code-nav-resolve-')))
    try {
      const lib = join(dir, 'node_modules', 'typescript', 'lib')
      mkdirSync(lib, { recursive: true })
      writeFileSync(join(lib, 'tsserver.js'), 'process.exit(42) // a repository must not get to run this')
      const launched: string[][] = []
      const provider = new TypeScriptNavProvider({
        spawn: (_command, args) => { launched.push([...args]); throw new Error('stop here') },
      })
      await expect(provider.query(query({ root: dir, path: join(dir, 'a.ts') }))).rejects.toBeInstanceOf(PreciseNavUnavailable)
      expect(launched[0][0]).toBe(resolveTsServer())
      expect(launched[0][0]).not.toContain(dir)
      expect(resolveTsServer()).toMatch(/node_modules\/typescript\/lib\/tsserver\.js$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TypeScriptNavProvider with a real tsserver', () => {
  it('answers definition, references and callers across files', { timeout: 60_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-nav-tsserver-')))
    const children: ChildProcess[] = []
    const provider = new TypeScriptNavProvider({
      spawn: (command, args, options) => {
        const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'ignore'] })
        children.push(child)
        return child as TsServerProcess
      },
    })
    try {
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }))
      writeFileSync(join(root, 'a.ts'), "export function greet(name: string) {\n  return 'hi ' + name\n}\n")
      writeFileSync(
        join(root, 'b.ts'),
        [
          "import { greet } from './a'",
          '',
          'export function first() {',
          "  return greet('a')",
          '}',
          '',
          'export const second = () => {',
          "  return greet('b')",
          '}',
          '',
        ].join('\n'),
      )
      const a = join(root, 'a.ts')
      const b = join(root, 'b.ts')

      let start = performance.now()
      const definition = await provider.query({ root, kind: 'definition', path: b, line: 4, character: 9 })
      const coldMs = performance.now() - start
      expect(definition).toEqual([expect.objectContaining({ path: a, line: 1, character: 16 })])

      start = performance.now()
      const references = await provider.query({ root, kind: 'references', path: a, line: 1, character: 16 })
      const warmMs = performance.now() - start
      expect(references).toHaveLength(4)
      expect(references.filter((ref) => ref.path === b).map((ref) => ref.line)).toEqual([1, 4, 8])
      expect(references.find((ref) => ref.line === 4)?.preview).toBe("  return greet('a')")

      const callers = await provider.query({ root, kind: 'callers', path: a, line: 1, character: 16 })
      expect(callers.map(({ path, line, character, container }) => ({ path, line, character, container }))).toEqual([
        { path: b, line: 4, character: 9, container: 'first' },
        { path: b, line: 8, character: 9, container: 'second' },
      ])
      console.info(`[code-nav-tsserver] real tsserver: cold definition ${coldMs.toFixed(0)} ms, warm references ${warmMs.toFixed(0)} ms`)

      // tsserver exits on its own when its stdin closes, so it can't outlive the daemon.
      expect(children).toHaveLength(1)
      const exited = new Promise((resolve) => children[0].once('exit', resolve))
      children[0].stdin!.end()
      await exited
      expect(provider.stats()).toEqual([])
    } finally {
      await provider.dispose()
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
