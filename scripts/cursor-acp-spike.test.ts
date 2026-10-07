import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The standalone probe intentionally uses Node builtins and remains plain JS.
// @ts-expect-error No declaration file for this isolated .mjs spike.
import { runProbe } from './cursor-acp-spike.mjs'

const fixture = fileURLToPath(new URL('./cursor-acp-fixtures-peer.mjs', import.meta.url))
const cli = fileURLToPath(new URL('./cursor-acp-spike.mjs', import.meta.url))
const exec = promisify(execFile)
const directories: string[] = []
type Boot = { event: 'boot'; phase: string; pid: number; cwd: string; home: string; inheritedSecrets: boolean }
type Received = { event: 'received'; message: { jsonrpc: string; id: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown } }

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function probe(scenario = 'normal', initializeId: string | number = 0, timeoutMs = 3000) {
  const directory = await mkdtemp(join(tmpdir(), 'cursor-acp-fixtures-'))
  directories.push(directory)
  const auditPath = join(directory, 'audit.jsonl')
  const report = await runProbe({ agent: process.execPath, argsPrefix: [fixture, scenario, auditPath], initializeId, timeoutMs })
  const events = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) as Array<Boot | Received>
  const boots = events.filter((event): event is Boot => event.event === 'boot')
  const messages = events.filter((event): event is Received => event.event === 'received').map((event) => event.message)
  return { report, boots, messages }
}

async function assertGone(boots: Boot[]) {
  for (const boot of boots) {
    expect(() => process.kill(boot.pid, 0)).toThrow()
    await expect(access(boot.cwd)).rejects.toThrow()
    await expect(access(boot.home)).rejects.toThrow()
  }
}

describe('Cursor ACP spike with real fake stdio processes', () => {
  it.each([0, '0', 'client:init'])('correlates initialize ID %j and separates server requests, responses, and notifications', async (id) => {
    vi.stubEnv('CURSOR_API_KEY', 'fixture-secret')
    vi.stubEnv('CURSOR_AUTH_TOKEN', 'fixture-secret')
    vi.stubEnv('COMMANDO_TOKEN', 'fixture-secret')
    vi.stubEnv('HTTPS_PROXY', 'fixture-secret')
    const { report, boots, messages } = await probe('normal', id)
    expect(report.status).toBe('initialized')
    expect(report.installedVersion).toBe('2026.10.01-e373342')
    expect(report.advertised).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true, 'promptCapabilities.image': true, 'promptCapabilities.audio': false,
        'promptCapabilities.embeddedContext': true, 'mcpCapabilities.http': false, 'mcpCapabilities.sse': true,
        'sessionCapabilities.list': true, 'sessionCapabilities.fork': false,
      },
      authMethodIds: ['cursor_login'], unreportedAuthMethodCount: 1,
      agentInfoReported: false, unrecognizedMetadataOmitted: true,
    })
    expect(report.counters).toEqual({
      requestsCancelled: 3, requestsUnsupported: 4, unmatchedResponses: 1,
      notifications: { 'session/update': 1, 'cursor/update_todos': 2, 'cursor/task': 1, 'cursor/generate_image': 1, other: 4 },
    })
    expect(messages[0]).toEqual({
      jsonrpc: '2.0', id, method: 'initialize', params: {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'commando-cursor-acp-spike', version: '0.1.0' },
      },
    })
    expect(messages.slice(1)).toEqual([
      ...[0, 'q:1', 'plan:1'].map((requestId) => ({ jsonrpc: '2.0', id: requestId, result: { outcome: { outcome: 'cancelled' } } })),
      ...['unknown:1', 'fs:1', 'term:1', 'task:1'].map((requestId) => ({
        jsonrpc: '2.0', id: requestId, error: { code: -32601, message: 'Unsupported method' },
      })),
    ])
    expect(JSON.stringify(report)).not.toContain('fixture-secret')
    expect(boots.map((boot) => boot.phase)).toEqual(['--version', 'acp'])
    expect(boots.every((boot) => !boot.inheritedSecrets)).toBe(true)
    expect(report.versionCleanup.exitObserved).toBe(true)
    expect(report.cleanup.exitObserved).toBe(true)
    expect(report.isolationRemoved).toBe(true)
    await assertGone(boots)
  })

  it.each(['timeout', 'wrong-id', 'version-timeout'])('enforces deadline and SIGKILLs a SIGTERM-resistant %s child', async (scenario) => {
    const start = Date.now()
    const { report, boots, messages } = await probe(scenario, 0, 700)
    expect(report.status).toBe('timeout')
    expect(Date.now() - start).toBeLessThan(2500)
    const cleanup = scenario === 'version-timeout' ? report.versionCleanup : report.cleanup
    expect(cleanup).toMatchObject({ forcedKill: true, exitObserved: true, signal: 'SIGKILL' })
    expect(messages.filter((message) => message.method)).toHaveLength(scenario === 'version-timeout' ? 0 : 1)
    expect(report.isolationRemoved).toBe(true)
    await assertGone(boots)
  })

  it.each([
    ['early-exit', 'child_exited_before_initialize'], ['malformed', 'invalid_json'],
    ['oversized', 'output_limit'], ['rpc-error', 'initialize_rpc_error'],
    ['unsupported-version', 'unsupported_protocol_version'],
  ])('reports safe failure for %s and observes process exit', async (scenario, status) => {
    const { report, boots } = await probe(scenario)
    expect(report.status).toBe(status)
    expect(JSON.stringify(report)).not.toContain('fixture-secret')
    expect(report.cleanup.exitObserved).toBe(true)
    expect(report.isolationRemoved).toBe(true)
    await assertGone(boots)
  })

  it('omits arbitrary version output', async () => {
    const { report, boots } = await probe('unsafe-version')
    expect(report.status).toBe('initialized')
    expect(report.installedVersion).toBeNull()
    expect(JSON.stringify(report)).not.toContain('fixture-secret')
    await assertGone(boots)
  })

  it('cancels an in-flight initialize and still forces cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cursor-acp-fixtures-'))
    directories.push(directory)
    const auditPath = join(directory, 'audit.jsonl')
    const controller = new AbortController()
    const pending = runProbe({
      agent: process.execPath, argsPrefix: [fixture, 'timeout', auditPath], timeoutMs: 3000,
      signal: controller.signal,
    })
    // Wait for fixture readiness, rather than racing signal-handler installation.
    let ready = false
    const deadline = Date.now() + 2000
    try {
      while (!ready && Date.now() < deadline) {
        const audit = await readFile(auditPath, 'utf8').catch(() => '')
        ready = audit.includes('"method":"initialize"')
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally { controller.abort() }
    const report = await pending
    expect(ready).toBe(true)
    expect(report.status).toBe('cancelled')
    expect(report.cleanup).toMatchObject({ forcedKill: true, exitObserved: true, signal: 'SIGKILL' })
    const boots = (await readFile(auditPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line)).filter((event): event is Boot => event.event === 'boot')
    await assertGone(boots)
  })

  it('does not launch even a supplied executable without --live', async () => {
    const { stdout, stderr } = await exec(process.execPath, [cli, '--agent', '/does/not/exist'])
    expect(stdout).toContain('no subprocess unless --live')
    expect(stderr).toBe('')
  })

  it('rejects invalid CLI timeout without echoing user input', async () => {
    await expect(exec(process.execPath, [cli, '--live', '--timeout-ms', 'fixture-secret'])).rejects.toMatchObject({
      code: 1, stdout: '', stderr: 'Invalid probe options or probe failure. Use --help.\n',
    })
  })

  it('handles an executable spawn failure without leaking paths', async () => {
    const report = await runProbe({ agent: '/does/not/exist/fixture-secret', timeoutMs: 1000 })
    expect(report.status).toBe('spawn_failed')
    expect(report.isolationRemoved).toBe(true)
    expect(JSON.stringify(report)).not.toContain('fixture-secret')
  })
})
