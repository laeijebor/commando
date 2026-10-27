import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_DIFF_BYTE_LIMIT, CLOUD_DIFF_LINE_LIMIT, type CloudCreateInput, type CloudTask } from '../../shared/cloud-tasks.js'
import type { CloudCliRequest, CloudCliResult } from '../cloud-provider.js'
import { runCloudCli } from '../cloud-cli-runner.js'
import { CodexCloudAdapter } from './codex-cli.js'

const version = '0.0.0-synthetic'
const versionOutput = `codex-cli ${version}`
const fixture = (name: string) => readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8')
const receipt = fixture('create.stdout.txt')
const firstPage = fixture('list-page-1.json')
const lastPage = fixture('list-page-2.json')
const input: CloudCreateInput = {
  provider: 'codex', credentialContextId: 'codex:default', prompt: 'Synthetic test only', accountConfirmed: true,
  source: { environmentId: 'env_synthetic', branch: 'feature/synthetic', repository: 'synthetic/repo', checkoutPath: '/must/not/use', commit: 'abc' },
}
const task: CloudTask = {
  id: 'local-synthetic', provider: 'codex', credentialContextId: 'codex:default', verifiedAccountRef: null,
  title: 'Same title as the task being inspected', prompt: input.prompt, source: input.source,
  providerTaskId: 'task_synthetic_exact', providerUrl: receipt.trim(), identityEvidence: 'provider_receipt',
  deliveryState: 'accepted', remoteState: 'unknown', rawState: null, observationState: 'unavailable',
  lastObservedAt: null, providerUpdatedAt: null, createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z',
  revision: 1, archivedAt: null, issue: null,
}

function result(stdout = '', overrides: Partial<CloudCliResult> = {}): CloudCliResult {
  return { stdout, stderr: '', exitCode: 0, signal: null, spawned: true, timedOut: false, truncated: false, ...overrides }
}

function setup(outputs: Array<CloudCliResult | Error> = [result(receipt)], verifiedVersion = version) {
  const pending = [...outputs]
  const runner = vi.fn(async (request: CloudCliRequest): Promise<CloudCliResult> => {
    if (request.args[0] === '--version') return result(`${versionOutput}\n`)
    const next = pending.shift()
    if (!next) throw new Error('Unexpected network command')
    if (next instanceof Error) throw next
    return next
  })
  return { runner, adapter: new CodexCloudAdapter({ runner, verifiedVersion }), network: () => runner.mock.calls.map(([r]) => r).filter(r => r.args[0] !== '--version') }
}

afterEach(() => vi.unstubAllEnvs())

describe('Codex capability gate', () => {
  it('is gated by default, even with a recognized installed CLI', async () => {
    vi.stubEnv('COMMANDO_CLOUD_CODEX_VERIFIED_VERSION', '')
    const runner = vi.fn(async (_request: CloudCliRequest) => result(`${versionOutput}\n`))
    const adapter = new CodexCloudAdapter({ runner })
    expect(await adapter.info()).toMatchObject({ readiness: 'unverified', version, capabilities: {
      create: false, list: false, inspect: false, diff: false, link: true, sendMessage: false, accountIdentity: false,
    } })
    expect(await adapter.create(input)).toMatchObject({ state: 'rejected', issue: { code: 'codex_unverified' } })
    await expect(adapter.inspect(task)).rejects.toMatchObject({ code: 'codex_unverified' })
    await expect(adapter.diff(task)).rejects.toMatchObject({ code: 'codex_unverified' })
    expect(runner.mock.calls.every(([r]) => r.args[0] === '--version')).toBe(true)
  })

  it.each(['', versionOutput, '0.0.1', `${version} `, '^0.0.0', '*'])('requires exact semantic version %j', async verifiedVersion => {
    const { adapter } = setup([], verifiedVersion)
    expect((await adapter.info()).capabilities.create).toBe(false)
  })

  it('uses configured executable/context/version, with explicit options taking precedence', async () => {
    vi.stubEnv('COMMANDO_CODEX_CLI', '/synthetic/bin/codex')
    vi.stubEnv('COMMANDO_CLOUD_CODEX_VERIFIED_VERSION', version)
    vi.stubEnv('COMMANDO_CLOUD_CODEX_CONTEXT', 'codex:synthetic-account')
    const runner = vi.fn(async (_request: CloudCliRequest) => result(`${versionOutput}\n`))
    expect(await new CodexCloudAdapter({ runner }).info()).toMatchObject({ readiness: 'ready', credentialContextId: 'codex:synthetic-account', verifiedAccountRef: null })
    expect(runner.mock.calls[0][0]).toMatchObject({ executable: '/synthetic/bin/codex', args: ['--version'] })
    const explicit = new CodexCloudAdapter({ runner, executable: '/override', verifiedVersion: '', credentialContextId: 'codex:override' })
    expect(await explicit.info()).toMatchObject({ readiness: 'unverified', credentialContextId: 'codex:override' })
    expect(runner.mock.calls[1][0].executable).toBe('/override')
  })

  it.each([
    result('', { spawned: false, exitCode: null }), result(versionOutput, { timedOut: true }),
    result(versionOutput, { truncated: true }), result(versionOutput, { exitCode: 1 }), result('login token=SECRET'),
  ])('keeps linking available on discovery failure (%j)', async output => {
    const adapter = new CodexCloudAdapter({ runner: async () => output, verifiedVersion: version })
    const info = await adapter.info()
    expect(info.capabilities).toMatchObject({ link: true, create: false, list: false, inspect: false, diff: false })
    expect(info.version).toBeNull()
    expect(JSON.stringify(info)).not.toContain('SECRET')
  })

  it('rechecks version before every network operation', async () => {
    let currentVersion = versionOutput
    const runner = vi.fn(async (r: CloudCliRequest) => result(r.args[0] === '--version' ? currentVersion : receipt))
    const adapter = new CodexCloudAdapter({ runner, verifiedVersion: version })
    expect((await adapter.info()).capabilities.create).toBe(true)
    currentVersion = 'codex-cli 0.0.1'
    expect((await adapter.create(input)).state).toBe('rejected')
    expect(runner.mock.calls.filter(([r]) => r.args[0] === 'cloud')).toHaveLength(0)
  })

  it.each(['1.2.3', '1.2.3-alpha.4', '1.2.3-alpha.4+build.5'])('reports and gates on parsed semantic version %s', async detected => {
    const adapter = new CodexCloudAdapter({ runner: async () => result(`codex-cli ${detected}\n`), verifiedVersion: detected })
    expect(await adapter.info()).toMatchObject({ version: detected, readiness: 'ready', capabilities: { create: true, list: true, inspect: true, diff: true } })
  })
})

describe('Codex dispatch', () => {
  it.each(['codex:other', '', undefined, null])('rejects mismatched or missing draft context %j before any CLI call', async credentialContextId => {
    const { adapter, runner } = setup()
    const untrustedInput = { ...input, credentialContextId } as CloudCreateInput
    expect(await adapter.create(untrustedInput)).toMatchObject({ state: 'rejected', issue: { code: 'credential_context_mismatch' } })
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires the configured context rather than accepting the default draft context', async () => {
    const { runner, network } = setup()
    const credentialContextId = 'codex:configured'
    const adapter = new CodexCloudAdapter({ runner, verifiedVersion: version, credentialContextId })
    expect(await adapter.create(input)).toMatchObject({ state: 'rejected', issue: { code: 'credential_context_mismatch' } })
    expect(runner).not.toHaveBeenCalled()
    expect(await adapter.create({ ...input, credentialContextId })).toMatchObject({ state: 'accepted' })
    expect(network()).toHaveLength(1)
  })

  it('accepts the exact URL receipt and dispatches exact safe argv, not repository metadata', async () => {
    const { adapter, network } = setup()
    const controller = new AbortController()
    const prompt = '--env malicious; $(touch SHOULD_NOT_EXIST)\n"quoted"'
    expect(await adapter.create({ ...input, prompt }, controller.signal)).toEqual({ state: 'accepted', receipt: {
      providerTaskId: task.providerTaskId, providerUrl: receipt.trim(), evidence: 'provider_receipt',
    } })
    expect(network()).toEqual([{
      executable: 'codex', args: ['cloud', 'exec', '--env', 'env_synthetic', '--branch', 'feature/synthetic', '--', prompt],
      timeoutMs: 60_000, maxOutputBytes: 4096, signal: controller.signal,
    }])
  })

  it.each([
    '', 'Successfully created a task!', `Created: ${receipt}`, `${receipt}${receipt}`,
    JSON.stringify({ id: task.providerTaskId, url: receipt.trim() }),
    'https://chatgpt.com.evil/codex/tasks/task_synthetic_exact\n',
    'https://user@chatgpt.com/codex/tasks/task_synthetic_exact\n',
    'https://chatgpt.com:443/codex/tasks/task_synthetic_exact\n',
    'https://chatgpt.com/codex/tasks/../task_synthetic_exact\n',
    'https://chatgpt.com/codex/tasks/task_synthetic_exact/extra\n',
    `${receipt.trim()}?task=task_other\n`, `${receipt.trim()}#task_other\n`,
    'https://chatgpt.com/codex/tasks/task_%61bc\n',
    `https://chatgpt.com/codex/tasks/task_${'a'.repeat(160)}\n`,
    `\u001b[32m${receipt}\u001b[0m`, 'x'.repeat(4097),
  ])('does not scrape or guess a receipt from %j', async stdout => {
    const { adapter } = setup([result(stdout)])
    expect(await adapter.create(input)).toMatchObject({ state: 'delivery_unknown' })
  })

  it.each([
    result('', { timedOut: true, exitCode: null }), result('', { exitCode: 1, stderr: 'AUTH_SECRET' }),
    result(receipt, { truncated: true }), result('', { signal: 'SIGTERM' }),
    result('', { stderr: receipt }), new Error('SECRET after spawn'),
  ])('keeps ambiguous process results unknown without leaking diagnostics', async output => {
    const { adapter, network } = setup([output])
    const outcome = await adapter.create(input)
    expect(outcome.state).toBe('delivery_unknown')
    expect(JSON.stringify(outcome)).not.toContain('SECRET')
    expect(network()).toHaveLength(1)
  })

  it.each([
    { exitCode: 1 }, { timedOut: true, exitCode: null }, { signal: 'SIGTERM', exitCode: null },
    { timedOut: true, signal: 'SIGKILL', exitCode: null },
  ])('preserves a complete receipt despite later process failure %j', async failure => {
    const { adapter, network } = setup([result(receipt, failure)])
    expect(await adapter.create(input)).toEqual({ state: 'accepted', receipt: {
      providerTaskId: task.providerTaskId, providerUrl: receipt.trim(), evidence: 'provider_receipt',
    } })
    expect(network()).toHaveLength(1)
  })

  it.each([
    receipt.trim(), receipt.trim().slice(0, -4), `${receipt}${receipt}`,
    `${receipt}https://chatgpt.com/codex/tasks/task_conflicting\n`,
    `${receipt}partial`, 'https://chatgpt.com/codex/tasks/\n',
  ])('never treats incomplete or multiple receipt output as acceptance', async stdout => {
    for (const failure of [{}, { exitCode: 1 }, { timedOut: true, exitCode: null }]) {
      const { adapter } = setup([result(stdout, failure)])
      expect((await adapter.create(input)).state).toBe('delivery_unknown')
    }
  })

  it('rejects runner truncation even with a complete-looking receipt before timeout', async () => {
    const { adapter } = setup([result(receipt, { truncated: true, timedOut: true, exitCode: null })])
    expect((await adapter.create(input)).state).toBe('delivery_unknown')
  })

  it('distinguishes a known pre-spawn failure', async () => {
    const { adapter } = setup([result('', { spawned: false, exitCode: null })])
    expect(await adapter.create(input)).toMatchObject({ state: 'rejected', issue: { code: 'cli_not_started' } })
  })

  it.each([
    { ...input, accountConfirmed: false }, { ...input, provider: 'claude' as const },
    ...['', ' ', '-', '\0', 'x'.repeat(16_385)].map(prompt => ({ ...input, prompt })),
    ...['', '--help', ' env', 'a b', 'a\0b', 'a'.repeat(161)].map(environmentId => ({ ...input, source: { ...input.source, environmentId } })),
    ...['', '--help', 'main\n--env', 'a;touch', 'a..b', 'a//b', 'a/.b', 'a.lock', 'a/', 'a'.repeat(256)].map(branch => ({ ...input, source: { ...input.source, branch } })),
  ])('rejects invalid input before any process call', async bad => {
    const { adapter, runner } = setup()
    expect((await adapter.create(bad)).state).toBe('rejected')
    expect(runner).not.toHaveBeenCalled()
  })

  it('freezes arguments before asynchronous discovery and checks cancellation before dispatch', async () => {
    const changing = structuredClone(input)
    const controller = new AbortController()
    const { adapter, runner, network } = setup()
    runner.mockImplementationOnce(async () => {
      changing.source.environmentId = '--help'
      changing.prompt = 'changed'
      return result(versionOutput)
    })
    await adapter.create(changing)
    expect(network()[0].args).toEqual(['cloud', 'exec', '--env', 'env_synthetic', '--branch', 'feature/synthetic', '--', input.prompt])
    controller.abort()
    expect(await adapter.create(input, controller.signal)).toMatchObject({ state: 'rejected', issue: { code: 'dispatch_aborted' } })
    expect(network()).toHaveLength(1)
  })

  it('does not call any CLI for unsupported follow-up', async () => {
    const { adapter, runner } = setup()
    expect(await adapter.sendMessage(task, 'follow up')).toMatchObject({ state: 'rejected', issue: { code: 'unsupported' } })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('Codex exact-ID observation', () => {
  it('pages to the exact ID, ignoring a same-title/time task with a conflicting state', async () => {
    const { adapter, network } = setup([result(firstPage), result(lastPage)])
    expect(await adapter.inspect(task)).toEqual({ remoteState: 'result_ready', rawState: 'ready', updatedAt: '2026-09-13T10:00:00Z' })
    expect(network().map(r => r.args)).toEqual([
      ['cloud', 'list', '--json', '--limit', '20'],
      ['cloud', 'list', '--json', '--limit', '20', '--cursor=synthetic-page-2'],
    ])
  })

  it.each([
    ['pending', 'unknown'], ['ready', 'result_ready'], ['applied', 'result_ready'], ['error', 'failed'],
    ['running', 'unknown'], ['completed', 'unknown'], ['queued', 'unknown'], ['cancelled', 'unknown'], ['READY', 'unknown'],
    ['future-status', 'unknown'], ['toString', 'unknown'],
  ])('normalizes only documented evidence: %s -> %s', async (status, remoteState) => {
    const page = JSON.parse(lastPage)
    page.tasks[0].status = status
    const { adapter } = setup([result(JSON.stringify(page))])
    expect(await adapter.inspect(task)).toMatchObject({ remoteState, rawState: status })
  })

  it('does not invent remote failure on missing task or near ID', async () => {
    const page = JSON.parse(lastPage)
    page.tasks[0].id += '_near'
    page.tasks[0].url += '_near'
    const { adapter } = setup([result(JSON.stringify(page))])
    await expect(adapter.inspect(task)).rejects.toMatchObject({ code: 'task_not_observed' })
    expect(task.remoteState).toBe('unknown')
  })

  it('stops repeated cursors and bounds a scan to five pages', async () => {
    const repeated = setup([result(firstPage), result(firstPage)])
    await expect(repeated.adapter.inspect(task)).rejects.toMatchObject({ code: 'codex_cursor_repeated' })
    expect(repeated.network()).toHaveLength(2)
    const scan = setup(Array.from({ length: 5 }, (_, i) => result(JSON.stringify({ tasks: [], cursor: `page-${i}` }))))
    await expect(scan.adapter.inspect(task)).rejects.toMatchObject({ code: 'codex_scan_limit' })
    expect(scan.network()).toHaveLength(5)
  })

  it('passes option-like cursors as a single bound value', async () => {
    const { adapter, network } = setup([result('{"tasks":[],"cursor":"--help"}'), result(lastPage)])
    await adapter.inspect(task)
    expect(network()[1].args.at(-1)).toBe('--cursor=--help')
  })

  it.each([
    'not json', '[]', '{}', '{"tasks":[]}', '{"tasks":[],"cursor":3}', '{"tasks":[],"cursor":""}',
    JSON.stringify({ tasks: [], cursor: 'a'.repeat(2049) }),
    JSON.stringify({ tasks: [], cursor: 'line\nbreak' }),
    JSON.stringify({ tasks: Array(21).fill(JSON.parse(lastPage).tasks[0]), cursor: null }),
    ...[
      { id: 'task_different' }, { url: 'https://evil.example/task_synthetic_exact' }, { status: null },
      { status: '' }, { status: 'a'.repeat(129) }, { status: '\u001b[32mready' },
      { updated_at: null }, { updated_at: 'yesterday' }, { updated_at: '1' },
    ].map(change => JSON.stringify({ tasks: [{ ...JSON.parse(lastPage).tasks[0], ...change }], cursor: null })),
    JSON.stringify({ tasks: Array(2).fill(JSON.parse(lastPage).tasks[0]), cursor: null }),
    ' '.repeat(256 * 1024 + 1),
  ])('fails closed on invalid listing format', async stdout => {
    const { adapter } = setup([result(stdout)])
    await expect(adapter.inspect(task)).rejects.toMatchObject({ code: 'codex_output_unrecognized' })
  })

  it.each([result(lastPage, { truncated: true }), result(lastPage, { exitCode: 1 }), result(lastPage, { timedOut: true }), new Error('SECRET')])('does not derive remote state from failed reads', async output => {
    const { adapter } = setup([output])
    await expect(adapter.inspect(task)).rejects.toMatchObject({ code: 'codex_read_failed' })
  })

  it.each([
    { ...task, providerTaskId: '--help' }, { ...task, providerTaskId: receipt.trim() },
    { ...task, providerTaskId: null }, { ...task, provider: 'claude' as const }, { ...task, credentialContextId: 'codex:other' },
  ])('validates identity/context before reads', async invalidTask => {
    const { adapter, runner } = setup()
    await expect(adapter.inspect(invalidTask)).rejects.toThrow()
    await expect(adapter.diff(invalidTask)).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('Codex read-only diff', () => {
  it('returns plaintext code and sends only the documented diff command', async () => {
    const text = fixture('result.diff')
    const { adapter, network } = setup([result(text)])
    expect(await adapter.diff(task)).toEqual({ text, truncated: false })
    expect(network()[0]).toMatchObject({ args: ['cloud', 'diff', task.providerTaskId], maxOutputBytes: CLOUD_DIFF_BYTE_LIMIT })
    expect(network()[0]).not.toHaveProperty('cwd')
  })

  it('removes terminal escapes and visibly escapes unsafe control bytes', async () => {
    const { adapter } = setup([result('\u001b[31m+hello\u001b[0m\r\n+\0\r\tend')])
    expect(await adapter.diff(task)).toEqual({ text: '+hello\n+\\u0000\\u000d\tend', truncated: false })
  })

  it.each(['x'.repeat(CLOUD_DIFF_BYTE_LIMIT + 1), '🙂'.repeat(CLOUD_DIFF_BYTE_LIMIT), '\0'.repeat(50_000)])('bounds UTF-8 bytes after escaping', async text => {
    const { adapter } = setup([result(text)])
    const diff = await adapter.diff(task)
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(CLOUD_DIFF_BYTE_LIMIT)
    expect(diff.text).not.toContain('\ufffd')
  })

  it('bounds lines independently and preserves exact-bound output', async () => {
    const { adapter } = setup([result(Array(5001).fill('+line').join('\n')), result('x'.repeat(CLOUD_DIFF_BYTE_LIMIT))])
    const diff = await adapter.diff(task)
    expect(diff.truncated).toBe(true)
    expect(diff.text.split('\n')).toHaveLength(CLOUD_DIFF_LINE_LIMIT)
    expect((await adapter.diff(task)).truncated).toBe(false)
  })

  it('returns explicit runner-capped partial text but not a timeout', async () => {
    const { adapter } = setup([
      result('+partial', { truncated: true, exitCode: null, signal: 'SIGTERM' }),
      result('+partial', { truncated: true, timedOut: true, exitCode: null }),
    ])
    expect(await adapter.diff(task)).toEqual({ text: '+partial', truncated: true })
    await expect(adapter.diff(task)).rejects.toMatchObject({ code: 'codex_diff_unavailable' })
  })

  it.each([result('failed', { exitCode: 1 }), result('', { spawned: false }), result('', { signal: 'SIGTERM' })])('does not return diagnostics as a successful diff', async output => {
    const { adapter } = setup([output])
    await expect(adapter.diff(task)).rejects.toMatchObject({ code: 'codex_diff_unavailable' })
  })
})

describe('Codex synthetic executable through the shared runner', () => {
  it('uses the default runner and retains local linking when the configured CLI is missing', async () => {
    const adapter = new CodexCloudAdapter({ executable: '/nonexistent-commando-synthetic/codex', verifiedVersion: version })
    expect(await adapter.info()).toMatchObject({ readiness: 'missing_cli', capabilities: { link: true, create: false, inspect: false, diff: false } })
  })

  it('exercises actual spawn, argv, isolated env, receipt, paging and diff without a provider', async () => {
    vi.stubEnv('CODEX_STARTING_DIFF', 'MUST_NOT_UPLOAD')
    vi.stubEnv('COMMANDO_TOKEN', 'SYNTHETIC_MUST_NOT_FORWARD')
    const path = fileURLToPath(new URL('./fixtures/codex/fake-cli.mjs', import.meta.url))
    const runner = (request: CloudCliRequest) => runCloudCli({ ...request, executable: process.execPath, args: [path, ...request.args] })
    const adapter = new CodexCloudAdapter({ runner, verifiedVersion: version })
    expect((await adapter.info()).readiness).toBe('ready')
    expect(await adapter.create({ ...input, prompt: '--dangerous-option; $(false)' })).toMatchObject({ state: 'accepted' })
    expect(await adapter.inspect(task)).toMatchObject({ remoteState: 'result_ready', rawState: 'ready' })
    expect(await adapter.diff(task)).toEqual({ text: fixture('result.diff'), truncated: false })
    expect(await adapter.create({ ...input, prompt: 'SYNTHETIC_NONZERO' })).toMatchObject({ state: 'accepted' })
  })
})
