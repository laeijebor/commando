import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudCreateInput, CloudMessageInput, CloudTask } from '../../shared/cloud-tasks.js'
import { CloudTaskError, type CloudCliRequest, type CloudCliResult } from '../cloud-provider.js'
import { ClaudeCloudAdapter } from './claude-cli.js'

const success = readFileSync(new URL('./fixtures/claude/success.json', import.meta.url), 'utf8')
const failure = readFileSync(new URL('./fixtures/claude/rejected.json', import.meta.url), 'utf8')
const task: CloudTask = {
  id: 'local-synthetic', provider: 'claude', credentialContextId: 'claude-default', verifiedAccountRef: null,
  title: 'Synthetic task', prompt: 'Original prompt', source: {}, providerTaskId: 'session_synthetic',
  providerUrl: 'https://claude.ai/code/session_synthetic', identityEvidence: 'user_link',
  deliveryState: 'accepted', remoteState: 'unknown', rawState: null, observationState: 'unavailable',
  lastObservedAt: null, providerUpdatedAt: null, createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z', revision: 1, archivedAt: null, issue: null,
}
const createInput: CloudCreateInput = {
  provider: 'claude', credentialContextId: task.credentialContextId,
  prompt: 'Do work', source: {}, accountConfirmed: true,
}
const result = (overrides: Partial<CloudCliResult> = {}): CloudCliResult => ({
  stdout: success, stderr: '', exitCode: 0, signal: null, spawned: true, timedOut: false, truncated: false, ...overrides,
})
function setup(reply = result(), version = result({ stdout: '9.9.9 (Claude Code)\n' })) {
  const runner = vi.fn(async (request: CloudCliRequest) => request.args[0] === '--version' ? version : reply)
  const adapter = new ClaudeCloudAdapter({ runner, executable: '/local/fake-claude', verifiedVersion: '9.9.9', credentialContextId: 'claude-default' })
  return { runner, adapter }
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('ClaudeCloudAdapter capability discovery', () => {
  it('exposes the frozen provider shape and enables only verified follow-up and local linking', async () => {
    const { adapter, runner } = setup()
    expect(await adapter.info()).toMatchObject({
      id: 'claude', version: '9.9.9', readiness: 'ready', verifiedAccountRef: null,
      capabilities: { create: false, link: true, sendMessage: true, list: false, inspect: false, diff: false, accountIdentity: false },
    })
    expect(runner.mock.calls[0][0]).toMatchObject({ executable: '/local/fake-claude', args: ['--version'], timeoutMs: 3000, maxOutputBytes: 4096, claudeConfigDir: undefined })
  })

  it('distinguishes missing CLI from installed but unverified, preserving local linking in both cases', async () => {
    const missing = setup(result(), result({ spawned: false, exitCode: null, stdout: '' })).adapter
    expect(await missing.info()).toMatchObject({ readiness: 'missing_cli', version: null, capabilities: { link: true, sendMessage: false } })
    vi.stubEnv('COMMANDO_CLOUD_CLAUDE_VERIFIED_VERSION', undefined)
    const { runner } = setup()
    const unverified = new ClaudeCloudAdapter({ runner })
    expect(await unverified.info()).toMatchObject({ readiness: 'unverified', version: '9.9.9', capabilities: { link: true, sendMessage: false } })
    expect((await unverified.info()).reason).toContain('user-supplied')
    await expect(unverified.sendMessage(task, 'Hello')).resolves.toMatchObject({ state: 'rejected', issue: { code: 'capability_unverified' } })
    expect(runner).toHaveBeenCalledOnce()
  })

  it.each(['9.9', '9.9.8', '9.9.9 (Claude Code)', '*', '9.9.9\n'])('requires an exact version attestation: %s', async (verifiedVersion) => {
    const { runner } = setup()
    expect(await new ClaudeCloudAdapter({ runner, verifiedVersion }).info()).toMatchObject({ readiness: 'unverified', capabilities: { sendMessage: false } })
  })

  it.each([
    result({ stdout: 'secret token or unexpected format' }),
    result({ stdout: '9.9.9 (Claude Code)\nunexpected extra line' }),
    result({ stdout: '9.9.9', timedOut: true }),
    result({ stdout: '9.9.9', truncated: true }),
    result({ stdout: '9.9.9', exitCode: 1 }),
    result({ stdout: '9.9.9', signal: 'SIGTERM' }),
  ])('fails closed on malformed/interrupted probe %# without exposing output', async (version) => {
    const { adapter } = setup(result(), version)
    const info = await adapter.info()
    expect(info).toMatchObject({ readiness: 'error', version: null, capabilities: { link: true, sendMessage: false } })
    expect(info.reason).not.toContain('secret token')
  })

  it('sanitizes thrown discovery errors', async () => {
    const adapter = new ClaudeCloudAdapter({ runner: async () => { throw new Error('secret diagnostic') } })
    expect(await adapter.info()).toMatchObject({ readiness: 'error', capabilities: { link: true, sendMessage: false } })
    expect(JSON.stringify(await adapter.info())).not.toContain('secret diagnostic')
  })

  it('single-flights and caches probes briefly, then detects a version change', async () => {
    let now = 10
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { adapter, runner } = setup()
    await Promise.all([adapter.info(), adapter.info(), adapter.info()])
    await adapter.info()
    expect(runner).toHaveBeenCalledOnce()
    now += 5001
    runner.mockResolvedValue(result({ stdout: '9.9.10 (Claude Code)' }))
    expect(await adapter.info()).toMatchObject({ readiness: 'unverified', version: '9.9.10', capabilities: { sendMessage: false } })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('uses local daemon configuration defaults and explicit constructor overrides', async () => {
    vi.stubEnv('COMMANDO_CLAUDE_CLI', '/configured/fake-claude')
    vi.stubEnv('COMMANDO_CLOUD_CLAUDE_VERIFIED_VERSION', '9.9.9')
    vi.stubEnv('COMMANDO_CLOUD_CLAUDE_CONTEXT', 'claude-context-2')
    const { runner } = setup()
    const adapter = new ClaudeCloudAdapter({ runner })
    expect(await adapter.info()).toMatchObject({ readiness: 'ready', credentialContextId: 'claude-context-2' })
    expect(runner.mock.calls[0][0].executable).toBe('/configured/fake-claude')
    const override = setup()
    expect(await override.adapter.info()).toMatchObject({ readiness: 'ready', credentialContextId: 'claude-default' })
    expect(override.runner.mock.calls[0][0].executable).toBe('/local/fake-claude')
  })

  it('disables mutation for an invalid context identifier', async () => {
    const { runner } = setup()
    const adapter = new ClaudeCloudAdapter({ runner, verifiedVersion: '9.9.9', credentialContextId: 'bad/context' })
    expect(await adapter.info()).toMatchObject({ readiness: 'error', capabilities: { link: true, sendMessage: false } })
  })

  it('never dispatches creation, even when follow-up has an exact verified version', async () => {
    const { adapter, runner } = setup()
    expect(await adapter.create(createInput)).toMatchObject({ state: 'rejected', issue: { code: 'source_policy_unverified', message: expect.stringContaining('no-bundle') } })
    expect(runner).not.toHaveBeenCalled()
    const info = await adapter.info()
    expect(info.credentialContextId).toBe(createInput.credentialContextId)
    expect(info.reason).toContain('no-bundle')
  })
})

describe('ClaudeCloudAdapter connection isolation', () => {
  const maxDir = '/synthetic/claude-max'

  it('keeps concurrent version flights, cached results, labels and exact-version gates independent', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let now = 10
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const runner = vi.fn(async (request: CloudCliRequest) => {
      await gate
      return result({ stdout: request.claudeConfigDir === null ? '9.9.9 (Claude Code)' : '9.9.10 (Claude Code)' })
    })
    const team = new ClaudeCloudAdapter({ runner, executable: '/local/fake-claude', credentialContextId: 'claude:team', configDir: null, label: 'Claude Team', verifiedVersion: '9.9.9' })
    const max = new ClaudeCloudAdapter({ runner, executable: '/local/fake-claude', credentialContextId: 'claude:max', configDir: maxDir, label: 'Claude Max', verifiedVersion: '9.9.9' })
    expect(team.credentialContextId).toBe('claude:team')
    expect(max.credentialContextId).toBe('claude:max')
    expect(team.label).toBe('Claude Team')
    expect(max.label).toBe('Claude Max')
    const pending = Promise.all([team.info(), max.info(), team.info(), max.info()])
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.map(([request]) => request.claudeConfigDir)).toEqual([null, maxDir])
    release()
    const [teamInfo, maxInfo, teamRepeat, maxRepeat] = await pending
    expect(teamInfo).toMatchObject({ label: 'Claude Team', credentialContextId: 'claude:team', version: '9.9.9', readiness: 'ready', capabilities: { create: false, sendMessage: true } })
    expect(maxInfo).toMatchObject({ label: 'Claude Max', credentialContextId: 'claude:max', version: '9.9.10', readiness: 'unverified', capabilities: { create: false, sendMessage: false } })
    expect(teamRepeat).toEqual(teamInfo)
    expect(maxRepeat).toEqual(maxInfo)
    await Promise.all([max.info(), team.info()])
    expect(runner).toHaveBeenCalledTimes(2)
    now += 5001
    await max.info()
    expect(runner).toHaveBeenCalledTimes(3)
    expect(runner.mock.calls[2][0].claudeConfigDir).toBe(maxDir)
    await team.info()
    expect(runner).toHaveBeenCalledTimes(4)
    expect(runner.mock.calls[3][0].claudeConfigDir).toBeNull()
  })

  it('carries the immutable per-instance config selection on every concurrent probe and message', async () => {
    const { runner } = setup()
    const team = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:team', configDir: null, verifiedVersion: '9.9.9' })
    const max = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:max', configDir: maxDir, verifiedVersion: '9.9.9' })
    const responses = await Promise.all([
      team.sendMessage({ ...task, credentialContextId: team.credentialContextId }, 'Team message'),
      max.sendMessage({ ...task, credentialContextId: max.credentialContextId }, 'Max message'),
    ])
    expect(responses).toEqual([expect.objectContaining({ state: 'accepted' }), expect.objectContaining({ state: 'accepted' })])
    expect(runner).toHaveBeenCalledTimes(4)
    const requests = runner.mock.calls.map(([request]) => request)
    expect(requests.filter((request) => request.args[0] === '--version').map((request) => request.claudeConfigDir)).toEqual([null, maxDir])
    expect(requests.filter((request) => request.args[0] === '-p')).toEqual([
      expect.objectContaining({ claudeConfigDir: null, stdin: 'Team message', args: ['-p', '--cloud', 'session_synthetic', '--output-format', 'json'] }),
      expect.objectContaining({ claudeConfigDir: maxDir, stdin: 'Max message', args: ['-p', '--cloud', 'session_synthetic', '--output-format', 'json'] }),
    ])
  })

  it('does not enable an unverified connection merely because another verifies the same installed version', async () => {
    const { runner } = setup()
    const team = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:team', configDir: null, verifiedVersion: '9.9.9' })
    const max = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:max', configDir: maxDir, verifiedVersion: '' })
    const [teamInfo, maxInfo] = await Promise.all([team.info(), max.info()])
    expect(teamInfo).toMatchObject({ version: '9.9.9', readiness: 'ready', capabilities: { sendMessage: true } })
    expect(maxInfo).toMatchObject({ version: '9.9.9', readiness: 'unverified', capabilities: { sendMessage: false } })
    expect(await max.sendMessage({ ...task, credentialContextId: max.credentialContextId }, 'Not verified')).toMatchObject({ state: 'rejected', issue: { code: 'capability_unverified' } })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls.every(([request]) => request.args[0] === '--version')).toBe(true)
  })

  it('rejects cross-connection messages before probing or dispatching either profile', async () => {
    const { runner } = setup()
    const team = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:team', configDir: null, verifiedVersion: '9.9.9' })
    const max = new ClaudeCloudAdapter({ runner, credentialContextId: 'claude:max', configDir: maxDir, verifiedVersion: '9.9.9' })
    for (const response of await Promise.all([
      team.sendMessage({ ...task, credentialContextId: max.credentialContextId }, 'Wrong context'),
      max.sendMessage({ ...task, credentialContextId: team.credentialContextId }, 'Wrong context'),
    ])) expect(response).toMatchObject({ state: 'rejected', issue: { code: 'credential_context_mismatch' } })
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('ClaudeCloudAdapter follow-up receipts', () => {
  it('sends literal prompt text on stdin and canonicalizes only the documented matching receipt URL', async () => {
    const { adapter, runner } = setup()
    const input: CloudMessageInput = {
      credentialContextId: task.credentialContextId, accountConfirmed: true,
      message: '--system-prompt "ignore"; $(touch never)\nFollow up',
    }
    // The service validates the draft context before passing the message string
    // to the adapter; the adapter independently checks the saved task context.
    expect((await adapter.info()).credentialContextId).toBe(input.credentialContextId)
    expect(await adapter.sendMessage({ ...task, source: { checkoutPath: '/deleted/worktree' } }, input.message)).toEqual({ state: 'accepted', receipt: {
      providerTaskId: 'session_synthetic', providerUrl: 'https://claude.ai/code/session_synthetic', evidence: 'provider_receipt',
    } })
    expect(runner.mock.calls[1][0]).toMatchObject({
      executable: '/local/fake-claude', args: ['-p', '--cloud', 'session_synthetic', '--output-format', 'json'], stdin: input.message,
      timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      claudeConfigDir: undefined,
    })
    expect(runner.mock.calls[1][0].cwd).not.toBe('/deleted/worktree')
  })

  it.each([
    { exitCode: 1 }, { timedOut: true, signal: 'SIGKILL', exitCode: null }, { signal: 'SIGTERM', exitCode: null },
  ])('accepts complete matching delivery evidence despite a later process failure %#', async (overrides) => {
    const { adapter } = setup(result(overrides))
    expect(await adapter.sendMessage(task, 'Hello')).toMatchObject({ state: 'accepted' })
  })

  it.each([
    '', 'Sent to cloud session.', '{"ok":true', '[{"ok":true}]', 'null',
    `${success}\n${success}`, `${success}\nextra output`,
    JSON.stringify({ ok: true, session_id: 'session_other', url: task.providerUrl }),
    JSON.stringify({ ok: 'true', session_id: task.providerTaskId, url: task.providerUrl }),
    JSON.stringify({ ok: true, session_id: task.providerTaskId, url: task.providerUrl, error: 'conflict' }),
    JSON.stringify({ ok: true, session_id: task.providerTaskId }),
    '{"ok":false,"ok":true,"session_id":"session_synthetic","url":"https://claude.ai/code/session_synthetic"}',
    '{"ok":true,"session_id":"session_other","session_id":"session_synthetic","url":"https://claude.ai/code/session_synthetic"}',
    '{"ok":true,"session_id":"session_synthetic","url":"https://claude.ai/code/session_synthetic"}' + ' '.repeat(64 * 1024),
  ])('does not infer acceptance from malformed or conflicting output %#', async (stdout) => {
    const { adapter } = setup(result({ stdout }))
    expect(await adapter.sendMessage(task, 'Hello')).toMatchObject({ state: 'delivery_unknown' })
  })

  it.each([
    'https://claude.ai/code/session_other', 'https://evil.example/code/session_synthetic',
    'https://claude.ai@evil.example/code/session_synthetic', 'http://claude.ai/code/session_synthetic',
    'https://claude.ai/code/session_synthetic#secret', 'https://claude.ai/code/session_synthetic?token=secret',
    'https://claude.ai/code/session_synthetic/', 'https://claude.ai/code/%73ession_synthetic',
    'https://claude.ai:443/code/session_synthetic',
  ])('rejects mismatched or noncanonical URL evidence %s', async (url) => {
    const { adapter } = setup(result({ stdout: JSON.stringify({ ok: true, session_id: task.providerTaskId, url }) }))
    expect(await adapter.sendMessage(task, 'Hello')).toMatchObject({ state: 'delivery_unknown' })
  })

  it('accepts a cse_ ID using the same frozen validation and exact identity rules', async () => {
    const providerTaskId = 'cse_synthetic'
    const providerUrl = `https://claude.ai/code/${providerTaskId}`
    const { adapter } = setup(result({ stdout: JSON.stringify({ ok: true, session_id: providerTaskId, url: providerUrl }) }))
    expect(await adapter.sendMessage({ ...task, providerTaskId, providerUrl }, 'Hello')).toMatchObject({ state: 'accepted', receipt: { providerTaskId, providerUrl } })
  })

  it('maps only a complete authoritative failed-send envelope to a sanitized rejection', async () => {
    const { adapter } = setup(result({ stdout: failure, exitCode: 1, stderr: 'secret stderr' }))
    const response = await adapter.sendMessage(task, 'Hello')
    expect(response).toMatchObject({ state: 'rejected', issue: { code: 'provider_rejected' } })
    expect(JSON.stringify(response)).not.toContain('Session not found:')
    expect(JSON.stringify(response)).not.toContain('secret stderr')
  })

  it.each([
    result({ stdout: '', stderr: 'Error: auth expired secret token', exitCode: 1 }),
    result({ stdout: failure, timedOut: true }),
    result({ stdout: failure, signal: 'SIGTERM' }),
    result({ stdout: failure, truncated: true }),
    result({ stdout: success, truncated: true }),
    result({ stdout: '{"ok":false,"error":"secret token"}' }),
    result({ stdout: '{"ok":false,"session_id":"session_other","error":"missing"}' }),
    result({ stdout: '{"ok":false,"session_id":"session_synthetic","error":{}}' }),
    result({ stdout: '{"ok":false,"session_id":"session_synthetic","error":""}' }),
    result({ stdout: '{"ok":false,"session_id":"session_synthetic","error":"failed","url":"conflict"}' }),
  ])('preserves uncertainty for nonauthoritative or interrupted failures %#', async (reply) => {
    const { adapter } = setup(reply)
    const response = await adapter.sendMessage(task, 'Hello')
    expect(response).toMatchObject({ state: 'delivery_unknown' })
    expect(JSON.stringify(response)).not.toContain('secret token')
  })

  it('distinguishes no spawn from a runner throwing after possible dispatch', async () => {
    const { adapter, runner } = setup(result({ spawned: false, stdout: '', exitCode: null }))
    expect(await adapter.sendMessage(task, 'Hello')).toMatchObject({ state: 'rejected', issue: { code: 'cli_not_started' } })
    runner.mockRejectedValueOnce(new Error('secret token'))
    const response = await adapter.sendMessage(task, 'Hello')
    expect(response).toMatchObject({ state: 'delivery_unknown' })
    expect(JSON.stringify(response)).not.toContain('secret token')
  })

  it.each([
    { provider: 'codex' as const }, { providerTaskId: '--help' }, { providerTaskId: 'session_x;touch' },
    { providerTaskId: null }, { credentialContextId: 'other-context' }, { verifiedAccountRef: 'other-account' },
  ])('rejects invalid identity or context before any CLI invocation %#', async (patch) => {
    const { adapter, runner } = setup()
    expect(await adapter.sendMessage({ ...task, ...patch }, 'Hello')).toMatchObject({ state: 'rejected' })
    expect(runner).not.toHaveBeenCalled()
  })

  it.each(['', ' \n', 'bad\0input', 'x'.repeat(16_385)])('rejects invalid messages before probing %#', async (message) => {
    const { adapter, runner } = setup()
    expect(await adapter.sendMessage(task, message)).toMatchObject({ state: 'rejected', issue: { code: 'invalid_message' } })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not dispatch when cancelled before or during discovery', async () => {
    const { adapter, runner } = setup()
    expect(await adapter.sendMessage(task, 'Hello', AbortSignal.abort())).toMatchObject({ state: 'rejected', issue: { code: 'aborted' } })
    expect(runner).not.toHaveBeenCalled()
    const controller = new AbortController()
    runner.mockImplementationOnce(async () => { controller.abort(); return result({ stdout: '9.9.9' }) })
    expect(await adapter.sendMessage(task, 'Hello', controller.signal)).toMatchObject({ state: 'rejected', issue: { code: 'aborted' } })
    expect(runner).toHaveBeenCalledOnce()
  })

  it('preserves uncertainty if abort races a failed-send envelope and cooperative exit', async () => {
    const controller = new AbortController()
    const { adapter, runner } = setup()
    await adapter.info()
    runner.mockImplementationOnce(async () => { controller.abort(); return result({ stdout: failure }) })
    expect(await adapter.sendMessage(task, 'Hello', controller.signal)).toMatchObject({ state: 'delivery_unknown' })
  })

  it('returns structured unsupported errors without a local execution substitute', async () => {
    const { adapter, runner } = setup()
    for (const action of [() => adapter.inspect(task), () => adapter.diff(task)]) {
      await expect(action()).rejects.toBeInstanceOf(CloudTaskError)
      await expect(action()).rejects.toMatchObject({ status: 501, code: 'unsupported' })
    }
    expect(runner).not.toHaveBeenCalled()
  })
})
