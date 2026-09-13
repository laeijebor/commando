import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudLinkInput, CloudProvidersResponse, CloudTaskAction, CloudTaskDetail } from '../shared/cloud-tasks.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const ownerEmail = 'cloud-daemon-owner@example.test'
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  // Stop/reap children before removing their HOME, including failed startup/tests.
  const failures: unknown[] = []
  for (const dispose of cleanup.splice(0).reverse()) {
    try { await dispose() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Cloud daemon cleanup failed')
}, 20_000)

async function isolatedEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), 'commando-cloud-daemon-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const home = join(directory, 'home')
  const temporary = join(directory, 'tmp')
  const state = join(home, '.commando')
  await Promise.all([mkdir(state, { recursive: true }), mkdir(temporary)])
  const ownerToken = `owner-${randomUUID()}`
  const hookToken = `hook-${randomUUID()}`
  const hookPath = join(state, 'agent-hook-token')
  await writeFile(hookPath, `${hookToken}\n`, { mode: 0o600 })

  // Deliberately NOT {...process.env}: no shared sockets, auth, provider keys,
  // proxies, NODE_OPTIONS, or Commando paths. Defaults also resolve inside HOME.
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    SHELL: '/bin/sh',
    NODE_ENV: 'test',
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    COMMANDO_TMUX_SOCKET_NAME: `cloud-daemon-${randomUUID()}`,
    COMMANDO_TAILSCALE: 'false',
    COMMANDO_TRUSTED_ORIGINS: '',
    COMMANDO_TOKEN: ownerToken,
    COMMANDO_OWNER_EMAIL: ownerEmail,
    BETTER_AUTH_SECRET: `test-secret-${randomUUID()}`,
    COMMANDO_AGENT_HOOK_TOKEN_PATH: hookPath,
    COMMANDO_AUTH_DB_PATH: join(state, 'auth.sqlite'),
    COMMANDO_AUTH_SECRET_PATH: join(state, 'auth.secret'),
    COMMANDO_CLOUD_TASKS_PATH: join(state, 'cloud-tasks.sqlite'),
    COMMANDO_STATE_PATH: join(state, 'state.json'),
    COMMANDO_WEB_PANES_PATH: join(state, 'web-panes.json'),
    COMMANDO_SESSION_BRIEFS_PATH: join(state, 'session-briefs.json'),
    COMMANDO_SESSION_PREFERENCES_PATH: join(state, 'session-preferences.json'),
    COMMANDO_PANE_MARKS_PATH: join(state, 'pane-marks.json'),
    COMMANDO_PANE_SCREENSHOTS_PATH: join(state, 'pane-screenshots.json'),
    COMMANDO_PRS_PREFS_PATH: join(state, 'prs.json'),
    COMMANDO_LINEAR_ACCOUNTS_PATH: join(state, 'linear-accounts.json'),
    COMMANDO_CHROMIUM_PROFILE_DIR: join(state, 'chromium-profile'),
    COMMANDO_NOTES_DIR: join(state, 'notes'),
    // Absolute, nonexistent executables: even version probes cannot launch a
    // live provider or fall back to credentials/CLIs installed on the host.
    COMMANDO_CLAUDE_CLI: join(directory, 'nonexistent-claude'),
    COMMANDO_CODEX_CLI: join(directory, 'nonexistent-codex'),
    COMMANDO_CLOUD_CLAUDE_CONTEXT: 'claude:daemon-test',
    COMMANDO_CLOUD_CODEX_CONTEXT: 'codex:daemon-test',
  }
  return { env, ownerToken, hookToken, databasePath: env.COMMANDO_CLOUD_TASKS_PATH! }
}

async function ephemeralPort(): Promise<number> {
  // index.ts rejects port 0, so reserve an OS-assigned port until just before spawn.
  const reservation = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP port')
    return address.port
  } finally {
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
  }
}

async function startDaemon(fixture: Awaited<ReturnType<typeof isolatedEnvironment>>) {
  const port = await ephemeralPort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: projectRoot,
    env: { ...fixture.env, COMMANDO_PORT: String(port), BETTER_AUTH_URL: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let spawnError: Error | undefined
  let closed = false
  const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-32_768) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('error', (error) => { spawnError = error })
  const exited = new Promise<void>((resolve) => child.once('close', () => {
    closed = true
    resolve()
  }))
  const kill = (signal: NodeJS.Signals) => {
    // Signal only this ChildProcess, never a tmux server/process group or a reaped PID.
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const onExit = () => kill('SIGKILL')
  process.once('exit', onExit)
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    kill('SIGTERM')
    const escalation = setTimeout(() => kill('SIGKILL'), 5_000)
    try { await exited } finally {
      clearTimeout(escalation)
      process.off('exit', onExit)
    }
  })()
  cleanup.push(stop)

  const request = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init, signal: AbortSignal.timeout(5_000),
  })
  const ownerHeaders = { Authorization: `Bearer ${fixture.ownerToken}` }
  const json = async <T>(path: string, status = 200, init: RequestInit = {}): Promise<T> => {
    const response = await request(path, { ...init, headers: { ...ownerHeaders, ...init.headers } })
    const body = await response.text()
    expect(response.status, `${init.method ?? 'GET'} ${path}: ${body}\n${output}`).toBe(status)
    return JSON.parse(body) as T
  }
  try {
    const deadline = Date.now() + 30_000
    while (!output.includes(`[commando] browser:     ${origin}/`)) {
      if (closed || spawnError || Date.now() >= deadline) {
        throw new Error(`Daemon failed to start (${child.exitCode ?? child.signalCode}): ${spawnError ?? ''}\n${output}`)
      }
      await delay(50)
    }
    await json('/api/health')
  } catch (error) {
    await stop()
    throw error
  }
  return { origin, request, json, ownerHeaders, stop, child, logs: () => output }
}

function mutation(method: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  }
}

describe('cloud routes composed by the actual daemon', () => {
  it('enforces outer owner auth and persists local links, operations and archive across restart', async () => {
    const fixture = await isolatedEnvironment()
    const daemon = await startDaemon(fixture)
    const { json, request, ownerHeaders } = daemon
    // With no tmux server, some tmux versions leave the initial revision at 0.
    // Local HTTP availability and isolation do not depend on a running session.
    expect(await json('/api/snapshot')).toMatchObject({ sessions: [], windows: [], panes: [] })

    // Prove this really is the configured hook token, then show it cannot pass
    // the outer owner gate even for routes with their own valid request bodies.
    const hookHeaders = { Authorization: `Bearer ${fixture.hookToken}` }
    const hookResponse = await request('/api/pane-target-marker', {
      headers: { ...hookHeaders, 'X-Commando-Pane': '%999999' },
    })
    expect(hookResponse.status).toBe(404)
    expect(await hookResponse.json()).toEqual({ error: 'Tmux pane does not exist' })

    const protectedRoutes = [
      ['GET', '/api/cloud-providers'],
      ['GET', '/api/cloud-tasks'],
      ['POST', '/api/cloud-tasks'],
      ['POST', '/api/cloud-tasks/link'],
      ['GET', '/api/cloud-tasks/synthetic'],
      ['PATCH', '/api/cloud-tasks/synthetic'],
      ['GET', '/api/cloud-tasks/synthetic/diff'],
      ['POST', '/api/cloud-tasks/synthetic/refresh'],
      ['POST', '/api/cloud-tasks/synthetic/link'],
      ['POST', '/api/cloud-tasks/synthetic/messages'],
      ['GET', '/api/cloud-operations/synthetic'],
      ['GET', '/api/cloud-operations/by-key/synthetic'],
      ['POST', '/api/cloud-operations/synthetic/dispatch'],
    ] as const
    for (const [method, path] of protectedRoutes) {
      for (const headers of [{}, hookHeaders]) {
        const response = await request(path, { method, headers })
        expect(response.status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer realm="commando"')
        expect(await response.json()).toEqual({ error: 'Unauthorized' })
      }
      const forbidden = await request(path, {
        method, headers: { ...ownerHeaders, Origin: 'https://forbidden.example.test' },
      })
      expect(forbidden.status, `${method} ${path} forbidden Origin`).toBe(403)
      expect(await forbidden.json()).toEqual({ error: 'Invalid host or origin' })
    }
    expect((await request(`/api/cloud-tasks?token=${fixture.hookToken}`)).status).toBe(401)

    const providers = await json<CloudProvidersResponse>('/api/cloud-providers')
    expect(providers.installationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(providers.providers.map((provider) => provider.id).sort()).toEqual(['claude', 'codex'])
    for (const provider of providers.providers) {
      expect(provider).toMatchObject({
        readiness: 'missing_cli', version: null, verifiedAccountRef: null,
        credentialContextId: `${provider.id}:daemon-test`,
        capabilities: { create: false, link: true, list: false, inspect: false, sendMessage: false, diff: false, accountIdentity: false },
      })
    }
    expect(await json('/api/cloud-tasks')).toEqual({ tasks: [] })

    // Exercise Better Auth through index.ts too, not a hand-wired auth test server.
    const signup = await request('/api/auth/sign-up/email', {
      ...mutation('POST', { name: 'Test owner', email: ownerEmail, password: 'synthetic-test-password-1234' }),
      headers: { 'Content-Type': 'application/json', Origin: daemon.origin },
    })
    expect(signup.status, await signup.text()).toBe(200)
    const cookie = signup.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ')
    expect(cookie).toContain('better-auth.session_token=')
    for (const path of ['/api/cloud-providers', '/api/cloud-tasks']) {
      const response = await request(path, { headers: { Cookie: cookie } })
      expect(response.status, `cookie-only ${path}`).toBe(200)
      await response.body?.cancel()
    }
    const forbiddenCookie = await request('/api/cloud-tasks', {
      headers: { Cookie: cookie, Origin: 'https://forbidden.example.test' },
    })
    expect(forbiddenCookie.status).toBe(403)
    await forbiddenCookie.body?.cancel()

    const input: CloudLinkInput = {
      provider: 'claude', credentialContextId: 'claude:daemon-test',
      providerTaskId: 'session_synthetic_daemon_only', title: 'Synthetic daemon link', accountConfirmed: true,
    }
    for (const body of [
      { ...input, prompt: 'Unexpected prompt' },
      { ...input, providerTaskId: 'https://claude.ai/code/session_synthetic' },
      { ...input, accountConfirmed: 'true' },
      { ...input, credentialContextId: undefined },
    ]) {
      expect(await json('/api/cloud-tasks/link', 400, mutation('POST', body, randomUUID())))
        .toMatchObject({ code: 'invalid_request' })
    }
    expect(await json('/api/cloud-tasks/link', 400, mutation('POST', input)))
      .toMatchObject({ code: 'invalid_request' })
    expect(await json('/api/cloud-tasks/link', 409, mutation('POST', {
      ...input, credentialContextId: 'claude:wrong-context',
    }, randomUUID()))).toMatchObject({ code: 'context_mismatch' })
    expect(await json('/api/cloud-tasks/link', 409, mutation('POST', {
      ...input, accountConfirmed: false,
    }, randomUUID()))).toMatchObject({ code: 'account_confirmation_required' })
    expect(await json('/api/cloud-tasks', 409, mutation('POST', {
      provider: 'codex', credentialContextId: 'codex:daemon-test', accountConfirmed: true,
      prompt: 'Synthetic prompt, never dispatched', source: { environmentId: 'env_synthetic', branch: 'main' },
    }, randomUUID()))).toMatchObject({ code: 'capability_unavailable' })
    expect(await json('/api/cloud-tasks')).toEqual({ tasks: [] })

    // A cookie-only mutation succeeds, with no provider executable to invoke.
    const key = randomUUID()
    const link = mutation('POST', input, key)
    const linkedResponse = await request('/api/cloud-tasks/link', {
      ...link, headers: { ...link.headers, Cookie: cookie },
    })
    expect(linkedResponse.status).toBe(202)
    const linked = await linkedResponse.json() as CloudTaskAction
    expect(linked.reused).toBe(false)
    expect(linked.operation).toMatchObject({ taskId: linked.task.id, kind: 'link', idempotencyKey: key })
    const taskPath = `/api/cloud-tasks/${linked.task.id}`
    await expect.poll(async () => (await json<CloudTaskDetail>(taskPath)).task.deliveryState, {
      timeout: 10_000, interval: 50,
    }).toBe('accepted')
    const detail = await json<CloudTaskDetail>(taskPath)
    expect(detail.task).toMatchObject({
      id: linked.task.id, credentialContextId: input.credentialContextId,
      providerTaskId: input.providerTaskId, providerUrl: `https://claude.ai/code/${input.providerTaskId}`,
      identityEvidence: 'user_link', remoteState: 'unknown', observationState: 'unavailable', prompt: '',
    })
    expect(detail.operations).toHaveLength(1)
    expect(detail.operations[0]).toMatchObject({
      id: linked.operation.id, state: 'accepted', receipt: { evidence: 'user_link', providerTaskId: input.providerTaskId },
    })
    expect(await json(`${taskPath}/messages`, 409, mutation('POST', {
      credentialContextId: 'codex:daemon-test', accountConfirmed: true, message: 'Never dispatched',
    }, randomUUID()))).toMatchObject({ code: 'context_mismatch' })
    const { prompt: _prompt, ...summary } = detail.task
    expect(await json('/api/cloud-tasks')).toEqual({ tasks: [summary] })
    expect(await json(`/api/cloud-operations/${linked.operation.id}`)).toEqual({ operation: detail.operations[0] })
    expect(await json(`/api/cloud-operations/by-key/${key}`)).toEqual({ operation: detail.operations[0] })
    expect(await json('/api/cloud-tasks/link', 202, link)).toMatchObject({
      reused: true, task: { id: linked.task.id }, operation: { id: linked.operation.id },
    })
    expect(await json('/api/cloud-tasks/link', 409, mutation('POST', { ...input, title: 'Changed intent' }, key)))
      .toMatchObject({ code: 'idempotency_conflict' })
    const archived = await json<CloudTaskDetail>(taskPath, 200, mutation('PATCH', { archived: true }))
    expect(archived.task.archivedAt).toEqual(expect.any(String))
    expect(archived.task.providerTaskId).toBe(input.providerTaskId)
    expect(archived.operations).toEqual(detail.operations)
    expect(await json('/api/cloud-tasks?includeArchived=0')).toEqual({ tasks: [] })

    await daemon.stop()
    expect(daemon.child.exitCode, daemon.logs()).toBe(0)
    const restarted = await startDaemon(fixture)
    expect((await restarted.json<CloudProvidersResponse>('/api/cloud-providers')).installationId).toBe(providers.installationId)
    expect(await restarted.json(taskPath)).toEqual(archived)
    expect(await restarted.json(`/api/cloud-operations/by-key/${key}`)).toEqual({ operation: detail.operations[0] })
    expect(await restarted.json('/api/cloud-tasks/link', 202, link)).toMatchObject({
      reused: true, task: { id: linked.task.id }, operation: { id: linked.operation.id, state: 'accepted' },
    })
    const { prompt: _archivedPrompt, ...archivedSummary } = archived.task
    expect(await restarted.json('/api/cloud-tasks?includeArchived=1')).toEqual({ tasks: [archivedSummary] })
    expect(await restarted.json('/api/cloud-tasks?includeArchived=0')).toEqual({ tasks: [] })
    expect(await restarted.json('/api/snapshot')).toMatchObject({ sessions: [], panes: [] })
  }, 90_000)

  it('fails cloud routes closed on corrupt storage while keeping local daemon routes alive', async () => {
    const fixture = await isolatedEnvironment()
    const corruptBytes = Buffer.from('This is deliberately not a SQLite database.\n')
    await writeFile(fixture.databasePath, corruptBytes, { mode: 0o600 })
    const daemon = await startDaemon(fixture)
    expect(daemon.logs()).toContain('Cloud task storage unavailable; cloud routes are disabled')
    for (const [path, method] of [
      ['/api/cloud-providers', 'GET'],
      ['/api/cloud-tasks', 'GET'],
      ['/api/cloud-tasks/link', 'POST'],
      ['/api/cloud-operations/synthetic', 'GET'],
    ]) {
      const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${fixture.hookToken}` }]
      for (const headers of credentials) {
        const response = await daemon.request(path, { method, headers })
        expect(response.status, `disabled storage: ${method} ${path}`).toBe(401)
        expect(await response.json()).toEqual({ error: 'Unauthorized' })
      }
      expect(await daemon.json(path, 503, { method })).toMatchObject({ code: 'cloud_storage_unavailable' })
    }
    expect(await daemon.json('/api/health')).toMatchObject({ ok: true, sessions: 0 })
    expect(await daemon.json('/api/snapshot')).toMatchObject({ sessions: [], windows: [], panes: [] })
    await daemon.stop()
    expect(daemon.child.exitCode, daemon.logs()).toBe(0)
    expect(await readFile(fixture.databasePath)).toEqual(corruptBytes)
  }, 60_000)
})
