import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentStatusHookApi } from './agent-status-api.js'
import { AgentStatusRegistry } from './agent-status-registry.js'
import { verifyCursorHookAssociation } from './cursor-hook-ownership.js'

const execute = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally { vi.unstubAllEnvs() }
})

async function readArtifact(path: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for isolated tmux fixture ${path}`)
}

async function nativeTmuxPath(): Promise<string> {
  // A temporary HOME cannot configure a tool-manager shim. Resolve the actual
  // tmux binary from PATH without invoking or configuring those managers.
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try {
      const path = await realpath(join(directory, 'tmux'))
      if (basename(path) === 'tmux') return path
    } catch { /* next PATH entry */ }
  }
  throw new Error('A native tmux executable is required for the isolated ownership regression')
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

// Real tmux and ps, with a test-owned Cursor-shaped foreground producer. Only
// HTTP transport is replaced; the daemon handler and both ownership IO paths run.
it.each([['s.sock', false], ['s|12|34', false], ['s.sock', true]] as const)('accepts actual bridge and daemon ownership IO on isolated socket %s (spaces=%s)', async (socketName, spaces) => {
  // Short paths fit the Unix socket bound even on macOS's long default TMPDIR.
  const tmuxPath = await nativeTmuxPath()
  const fixturePath = dirname(tmuxPath) + delimiter + (process.env.PATH ?? '')
  const directory = await mkdtemp('/tmp/cc-cursor-io-')
  const socket = join(directory, socketName)
  const fixtureHome = spaces ? join(directory, 'Home With Spaces') : directory
  await mkdir(fixtureHome, { recursive: true })
  const environment = { PATH: fixturePath, HOME: fixtureHome, TERM: 'xterm-256color', SHELL: '/bin/sh', LC_ALL: 'C', TZ: 'UTC' }
  cleanups.push(async () => {
    // The explicit private socket is always supplied, including when setup failed.
    try { await execute(tmuxPath, ['-S', socket, 'kill-server'], { env: environment, timeout: 1_000 }) }
    catch { /* No test server exists if the sandbox rejected its socket. */ }
    await rm(directory, { recursive: true, force: true })
  })
  const bridge = join(directory, 'bridge.mjs')
  const tokenPath = join(directory, 'hook-token')
  const requestPath = join(directory, 'request.json')
  const answerPath = join(directory, 'answer.json')
  const resultPath = join(directory, 'result.json')
  const transport = join(directory, 'transport.mjs')
  const producer = join(fixtureHome, 'cursor-agent', 'versions', 'fixture', 'index.js')
  const token = 'isolated-cursor-tmux-test-token-at-least-32-characters'
  await writeFile(tokenPath, token, { mode: 0o600 })
  await mkdir(resolve(producer, '..'), { recursive: true })

  // Use the real installed TSX compiler so the embedded function includes its
  // actual keepNames transforms; no source imports are needed by the bridge.
  const moduleUrl = pathToFileURL(resolve('server/cursor-hooks.ts')).href
  await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
    `import { writeFile } from 'node:fs/promises'; import { generatedCursorBridge } from ${JSON.stringify(moduleUrl)}; await writeFile(${JSON.stringify(bridge)}, generatedCursorBridge(${JSON.stringify(tokenPath)}, 'isolated Cursor context'));`,
  ], { env: environment, timeout: 5_000 })
  expect(await readFile(bridge, 'utf8')).toContain('#{socket_path}|#{pid}|#{pane_pid}')

  await writeFile(transport, `import { readFile, writeFile } from 'node:fs/promises'
    globalThis.fetch = async (url, options) => {
      await writeFile(${JSON.stringify(requestPath)}, JSON.stringify({ url, headers: options.headers, body: JSON.parse(options.body), tmux: process.env.TMUX, pane: process.env.TMUX_PANE }))
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        options.signal.throwIfAborted()
        try {
          const reply = JSON.parse(await readFile(${JSON.stringify(answerPath)}, 'utf8'))
          return { ok: reply.status === 200, json: async () => reply.body }
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('isolated daemon response timed out')
    }
  `)
  await writeFile(producer, `const { spawn } = require('node:child_process')
    const { writeFile } = require('node:fs/promises')
    const child = spawn(${JSON.stringify(process.execPath)}, ['--import', ${JSON.stringify(transport)}, ${JSON.stringify(bridge)}, '--commando-cursor-status-hook', 'sessionStart'], { env: { ...process.env, COMMANDO_PORT: '4319' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (data) => { stdout += data }); child.stderr.on('data', (data) => { stderr += data })
    child.on('close', async (code) => { await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ code, stdout, stderr })) })
    child.stdin.end(JSON.stringify({ hook_event_name: 'sessionStart', conversation_id: 'conv-abcdefgh', generation_id: 'conv-abcdefgh', cursor_version: 'fixture' }))
    setInterval(() => {}, 1000)
  `)

  const wrapper = join(dirname(producer), 'agent')
  if (spaces) await writeFile(wrapper, '#!/bin/bash\nexec -a "$0" ' + shellQuote(process.execPath) + ' --use-system-ca ' + shellQuote(producer) + '\n', { mode: 0o700 })
  const command = spaces ? ['/bin/bash', wrapper] : [process.execPath, producer]
  const created = await execute(tmuxPath, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'cursor-delimiter', '-P', '-F', '#{pane_id}', ...command], {
    env: environment, timeout: 5_000,
  })
  const pane = created.stdout.trim()
  expect(pane, `tmux startup stderr: ${created.stderr}`).toMatch(/^%\d+$/)
  const sent = await readArtifact(requestPath)
  expect(sent.pane).toBe(pane)
  const tmuxEnvironment = /^(.*),\d+,\d+$/.exec(sent.tmux as string)
  expect(tmuxEnvironment).not.toBeNull()
  expect(await realpath(tmuxEnvironment![1])).toBe(await realpath(socket))
  expect(sent.url).toBe('http://127.0.0.1:4319/api/agent-status/hooks/cursor')
  expect(sent.body).toMatchObject({ association: { socketPath: await realpath(socket), serverPid: expect.any(Number), panePid: expect.any(Number), producerPid: expect.any(Number) } })

  // The daemon is outside tmux, while the bridge above inherited real TMUX and
  // TMUX_PANE. Use the production verifier and production IO, without ps mocks.
  vi.stubEnv('PATH', fixturePath)
  vi.stubEnv('TMUX', '')
  vi.stubEnv('TMUX_PANE', '')
  vi.stubEnv('COMMANDO_TMUX_SOCKET_NAME', '')
  vi.stubEnv('COMMANDO_TMUX_SOCKET_PATH', socket)
  const registry = new AgentStatusRegistry()
  const api = new AgentStatusHookApi({ token, registry, paneExists: (id) => id === pane,
    paneCommand: () => 'node', onChange: () => {}, verifyCursorAssociation: verifyCursorHookAssociation })
  const request = Readable.from([Buffer.from(JSON.stringify(sent.body))]) as IncomingMessage
  request.method = 'POST'
  request.headers = Object.fromEntries(Object.entries(sent.headers as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]))
  let status = 0
  let body: Record<string, unknown> = {}
  const response = {
    setHeader: () => {}, writeHead: (code: number) => { status = code },
    end: (raw: string) => { body = JSON.parse(raw) as Record<string, unknown> },
  } as unknown as ServerResponse
  expect(await api.handle(request, response, new URL(sent.url as string))).toBe(true)
  // Release the real child even when the assertion below reports a rejected POST.
  await writeFile(answerPath, JSON.stringify({ status, body }))
  expect({ status, body }).toEqual({ status: 200, body: { ok: true, changed: true, accepted: true } })
  expect(registry.get(pane)?.provider).toBe('cursor')
  const result = await readArtifact(resultPath)
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout as string)).toEqual({ additional_context: expect.stringContaining('agent --resume=conv-abcdefgh') })
}, 15_000)
