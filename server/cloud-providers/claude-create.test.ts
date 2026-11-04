import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSource } from '../../shared/cloud-tasks.js'
import { runCloudCli } from '../cloud-cli-runner.js'
import type { CloudCliRequest, CloudCliResult, CloudCliRunner } from '../cloud-provider.js'
import { claudeCreateReceipt, createClaudeSession, githubRemote, resolveClaudeSource, TRUST_PROMPT } from './claude-create.js'
import { meetsVerifiedVersion } from './verified-version.js'

const sha = 'a'.repeat(40)
const source: CloudSource = { checkoutPath: '/user/checkout', remoteUrl: 'https://github.com/acme/repo.git', branch: 'main', commit: sha }
const receipt = 'Created cloud session: Synthetic\nView: https://claude.ai/code/session_ABCDEFGHIJ1234?from=cli&m=0\nResume with: claude --teleport session_ABCDEFGHIJ1234\n'
const trust = ` Accessing workspace:
 /private/tmp/synthetic/checkout
 ${TRUST_PROMPT} (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`
const ok = (stdout = '', patch: Partial<CloudCliResult> = {}): CloudCliResult => ({ stdout, stderr: '', exitCode: 0, signal: null, spawned: true, timedOut: false, truncated: false, ...patch })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function setup({ screen = receipt, cloneFails = false, wrongCwd = false, aliasCwd = false, dead = true, missingTmux = false, throwAfterStart = false, timeoutMs = 1000 } = {}) {
  let checkout = ''
  let reportedCheckout = ''
  let trusted = false
  const runner = vi.fn(async (request: CloudCliRequest): Promise<CloudCliResult> => {
    const args = request.args
    if (request.executable === 'git') {
      if (args.includes('clone')) {
        checkout = args.at(-1)!
        expect((await stat(dirname(checkout))).mode & 0o777).toBe(0o700)
        if (cloneFails) return ok('', { exitCode: 1 })
        await mkdir(checkout)
        reportedCheckout = aliasCwd ? join(dirname(checkout), 'checkout-alias') : checkout
        if (aliasCwd) await symlink(checkout, reportedCheckout)
        return ok()
      }
      return ok(`${sha}\n`)
    }
    const command = args[4]
    if (command === '-V' && missingTmux) return ok('', { spawned: false, exitCode: null })
    if (command === 'capture-pane') {
      if (throwAfterStart) throw new Error('Synthetic crash')
      return ok(trusted ? receipt : screen)
    }
    if (command === 'display-message') return ok(args.at(-1) === '#{pane_dead}' ? (dead ? '1' : '0') : wrongCwd ? '/user/checkout' : reportedCheckout)
    if (command === 'send-keys') trusted = true
    return ok()
  })
  return { runner, checkout: () => checkout, trusted: () => trusted,
    create: (prompt = 'work', signal?: AbortSignal) => createClaudeSession(source, prompt, '/fake/claude', null, signal, { runner, pollMs: 1, timeoutMs }) }
}

describe('minimum verified stable versions', () => {
  it.each(['2.1.314', '2.1.315', '2.2.0', '3.0.0', '10.0.0'])('accepts %s at or above 2.1.314', (version) => expect(meetsVerifiedVersion(version, '2.1.314')).toBe(true))
  it.each(['2.1.313', '2.0.999', '1.99.999', '2.1', '*', '2.1.314-beta', '2.1.314+build', '2.1.314 (Claude Code)', '02.1.314'])('rejects installed or configured %s', (version) => {
    expect(meetsVerifiedVersion(version, '2.1.314')).toBe(false)
    expect(meetsVerifiedVersion('2.1.314', version)).toBe(/^(2\.1\.313|2\.0\.999|1\.99\.999)$/.test(version))
  })
})

describe('pushed Claude source', () => {
  it('resolves only the checkout GitHub origin and exact requested remote branch', async () => {
    const runner = vi.fn(async (request: CloudCliRequest) => ok(request.args[0] === 'remote' ? source.remoteUrl : request.args[0] === 'ls-remote' ? `${sha}\trefs/heads/main\n` : ''))
    expect(await resolveClaudeSource({ checkoutPath: '/user/checkout', branch: 'main', commit: 'b'.repeat(40) }, runner)).toEqual(source)
    expect(runner.mock.calls.map(([r]) => r.args)).toEqual([
      ['check-ref-format', 'refs/heads/main'], ['remote', 'get-url', 'origin'],
      ['ls-remote', '--exit-code', '--heads', '--', source.remoteUrl, 'refs/heads/main'],
    ])
  })
  it.each(['file:///user/checkout', '/user/checkout', 'ext::command', 'https://token@github.com/acme/repo', 'https://github.com.evil/acme/repo', 'https://github.com/acme/repo?token=x'])('rejects unsafe remote %s', (url) => expect(githubRemote(url)).toBeNull())
  it.each(['', `${sha}\trefs/heads/other`, `${sha}\trefs/heads/main\n${sha}\trefs/heads/other`])('rejects absent/ambiguous branch %#', async (stdout) => {
    const runner: CloudCliRunner = async (r) => ok(r.args[0] === 'remote' ? source.remoteUrl : r.args[0] === 'ls-remote' ? stdout : '')
    await expect(resolveClaudeSource(source, runner)).rejects.toMatchObject({ code: 'source_unverified' })
  })
})

describe('private Claude creation', () => {
  it('accepts strict receipt, passes one literal prompt argv and always removes clone/session', async () => {
    const { create, runner, checkout } = setup()
    const prompt = 'quotes " and \'\n$(touch never); --help'
    expect(await create(prompt)).toEqual({ state: 'accepted', receipt: claudeCreateReceipt(receipt) })
    const launch = runner.mock.calls.map(([r]) => r).find((r) => r.args.includes('new-session'))!
    expect(launch.args.slice(-3)).toEqual(['/fake/claude', '--cloud', prompt])
    expect(launch.args).toContain('/usr/bin/env')
    expect(launch.args).toContain('TERM=xterm-256color')
    expect(launch.args.some((arg) => arg.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false)
    expect(launch.args.some((arg) => arg === '-p' || arg === '-c' && launch.args[launch.args.indexOf(arg) - 1] === '/bin/sh')).toBe(false)
    expect(checkout()).not.toBe(source.checkoutPath)
    await expect(stat(dirname(checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
    const calls = runner.mock.calls.map(([r]) => r.args)
    expect(calls.at(-2)?.slice(4)).toEqual(['kill-session', '-t', 'create'])
    expect(calls.at(-1)?.slice(4)).toEqual(['kill-server'])
    expect(new Set(calls.filter((a) => a[0] === '-L').map((a) => a[1])).size).toBe(1)
  })
  it.each([false, true])('accepts the real long trust line only in the owned checkout (path alias: %s)', async (aliasCwd) => {
    const test = setup({ screen: trust, dead: false, aliasCwd })
    expect(await test.create()).toMatchObject({ state: 'accepted' })
    expect(test.trusted()).toBe(true)
  })
  it.each([
    { screen: trust, wrongCwd: true }, { screen: trust.replace(TRUST_PROMPT, 'Trust this other folder?') },
    { screen: trust.replace(TRUST_PROMPT, `Unexpected text ${TRUST_PROMPT}`) },
    { screen: trust.replace('❯ No, exit', '❯ Yes, I trust this folder') },
    { screen: trust.replace('Yes, I trust this folder', 'Trust this workspace') },
  ])('never approves unrelated or changed trust screens %#', async (options) => {
    const test = setup({ ...options, timeoutMs: 15 })
    expect(await test.create()).toMatchObject({ state: 'delivery_unknown' })
    expect(test.trusted()).toBe(false)
    await expect(stat(dirname(test.checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    { screen: 'unexpected screen', dead: false }, { screen: 'malformed receipt' },
    { throwAfterStart: true }, { screen: '', dead: true },
  ])('keeps timeout/malformed/crashed/killed pane unknown and cleans up %#', async (options) => {
    const test = setup(options)
    expect(await test.create()).toMatchObject({ state: 'delivery_unknown' })
    await expect(stat(dirname(test.checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(test.runner.mock.calls.at(-2)?.[0].args).toContain('kill-session')
  })
  it('rejects clone failure and removes scratch without starting Claude', async () => {
    const test = setup({ cloneFails: true })
    expect(await test.create()).toMatchObject({ state: 'rejected' })
    expect(test.runner.mock.calls.some(([r]) => r.args.includes('new-session'))).toBe(false)
    await expect(stat(dirname(test.checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(test.runner.mock.calls.at(-2)?.[0].args).toContain('kill-session')
  })
  it('rejects missing tmux without cloning or starting Claude', async () => {
    const test = setup({ missingTmux: true })
    expect(await test.create()).toMatchObject({ state: 'rejected' })
    expect(test.runner.mock.calls.some(([r]) => r.executable === 'git')).toBe(false)
  })
  it('rejects cancellation before launch but keeps cancellation after launch unknown', async () => {
    const test = setup()
    expect(await test.create('work', AbortSignal.abort())).toMatchObject({ state: 'rejected' })
    expect(test.runner.mock.calls.some(([r]) => r.args.includes('new-session'))).toBe(false)
    const controller = new AbortController()
    const runner: CloudCliRunner = async (r) => {
      const result = await test.runner(r)
      if (r.args.includes('new-session')) controller.abort()
      return result
    }
    expect(await createClaudeSession(source, 'work', '/fake/claude', null, controller.signal, { runner })).toMatchObject({ state: 'delivery_unknown' })
    await expect(stat(dirname(test.checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(test.runner.mock.calls.at(-2)?.[0].signal).toBeUndefined()
  })
  it('rejects a changed remote commit before starting Claude', async () => {
    const test = setup()
    const runner: CloudCliRunner = (r) => r.executable === 'git' && r.args[0] === 'rev-parse' ? Promise.resolve(ok('b'.repeat(40))) : test.runner(r)
    expect(await createClaudeSession(source, 'work', '/fake/claude', null, undefined, { runner })).toMatchObject({ state: 'rejected', issue: { code: 'source_changed' } })
    expect(test.runner.mock.calls.some(([r]) => r.args.includes('new-session'))).toBe(false)
    await expect(stat(dirname(test.checkout()))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    receipt.replace('session_ABCDEFGHIJ1234?from=cli&m=0', 'session_OTHERABCDE1234?from=cli&m=0'),
    receipt.replace('?from=cli&m=0', '?token=secret'), receipt.replace('claude.ai/', 'claude.ai.evil/'),
    receipt.replaceAll('session_ABCDEFGHIJ1234', 'session_short'), receipt.replaceAll('session_ABCDEFGHIJ1234', `session_${'A'.repeat(65)}`),
    receipt.trimEnd(), receipt + receipt,
  ])('does not accept malformed or conflicting receipts %#', (screen) => expect(claudeCreateReceipt(screen)).toBeNull())
})

describe('synthetic executable with real private tmux', () => {
  it('refuses interactive creation without TERM before emitting a receipt', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/claude/create.cjs', import.meta.url))
    const result = await runCloudCli({ executable: process.execPath, args: [fixture, '--cloud', 'work'] })
    expect(result).toMatchObject({ spawned: true, exitCode: 1, stdout: '' })
    expect(result.stderr).toContain('requires TERM')
    expect(claudeCreateReceipt(result.stdout)).toBeNull()
  })
  it('handles trust, literal argv, receipt and cleanup without any provider call', async (context) => {
    // Probe sockets, not just tmux -V: sandboxed hosts may install tmux but deny sockets.
    const root = await mkdtemp(join(tmpdir(), 'commando-fake-cloud-'))
    roots.push(root)
    const probeSocket = `commando-cloud-test-${process.pid}-${root.split('-').at(-1)}`
    const probe = await runCloudCli({ executable: 'tmux', args: ['-L', probeSocket, '-f', '/dev/null', 'new-session', '-d', '-s', 'probe', '/bin/sleep', '10'] })
    const alive = await runCloudCli({ executable: 'tmux', args: ['-L', probeSocket, 'has-session', '-t', 'probe'] })
    await runCloudCli({ executable: 'tmux', args: ['-L', probeSocket, 'kill-server'] })
    if (!probe.spawned || probe.exitCode !== 0 || alive.exitCode !== 0) { context.skip('Private tmux sockets are unavailable in this environment'); return }
    const executable = join(root, 'fake-claude')
    await writeFile(executable, `#!${process.execPath}\n${await readFile(new URL('./fixtures/claude/create.cjs', import.meta.url), 'utf8')}`)
    await chmod(executable, 0o700)
    let checkout = ''
    const requests: CloudCliRequest[] = []
    const runner: CloudCliRunner = async (request) => {
      requests.push(request)
      if (request.executable !== 'git') return runCloudCli(request)
      if (request.args.includes('clone')) { checkout = request.args.at(-1)!; await mkdir(checkout); await writeFile(join(checkout, 'pushed.txt'), 'remote content'); return ok() }
      return ok(sha)
    }
    const prompt = '"quoted"\n$(touch never) and \'single\''
    const result = await createClaudeSession(source, prompt, executable, root, undefined, { runner, pollMs: 25, timeoutMs: 5000 })
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'accepted' })
    expect(JSON.parse(await readFile(join(root, 'observed.json'), 'utf8'))).toEqual({ argv: ['--cloud', prompt], cwd: checkout, configDir: root, files: ['pushed.txt'], term: 'xterm-256color' })
    expect(await readFile(join(root, 'trusted'), 'utf8')).toBe(checkout)
    await expect(stat(dirname(checkout))).rejects.toMatchObject({ code: 'ENOENT' })
    const socket = requests.find((r) => r.executable === 'tmux')!.args[1]
    expect((await runCloudCli({ executable: 'tmux', args: ['-L', socket, 'has-session', '-t', 'create'] })).exitCode).not.toBe(0)
  }, 15_000)
})
