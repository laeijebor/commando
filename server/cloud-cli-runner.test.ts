import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCloudCli } from './cloud-cli-runner.js'
import type { CloudCliResult } from './cloud-provider.js'

let directory: string
let executable: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'commando-cloud-runner-'))
  executable = join(directory, 'fake claude.cjs')
  const source = await readFile(new URL('./cloud-providers/fixtures/claude/process.cjs', import.meta.url), 'utf8')
  // Append the handshake only to this test's temporary executable. Reaching it
  // proves the fixture installed its signal handler and emitted its output;
  // process creation alone does not prove either under concurrent-suite load.
  const handshake = `
if (['hang', 'cooperative', 'receipt-then-hang'].includes(process.argv[2])) {
  require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ready'), 'ready')
}
`
  await writeFile(executable, `#!${process.execPath}\n${source}\n${handshake}`, { mode: 0o700 })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

async function abortReadyProcess(mode: string, controller = new AbortController(), stdin?: string): Promise<CloudCliResult> {
  const pending = runCloudCli({ executable, args: [mode], signal: controller.signal, stdin })
  let settled = false
  void pending.then(() => { settled = true })
  try {
    const deadline = performance.now() + 4_000
    while (true) {
      if (settled) throw new Error('Fixture exited before the readiness handshake')
      try {
        if (await readFile(join(directory, 'ready'), 'utf8') === 'ready') break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (performance.now() >= deadline) throw new Error('Fixture did not confirm its signal handler was ready')
      await delay(10)
    }
    controller.abort()
    return await pending
  } finally {
    // Also terminate and await the owned child if the handshake/assertion fails.
    controller.abort()
    await pending
  }
}

describe('runCloudCli', () => {
  it('executes a fixed file with literal argv, explicit cwd, stdin and an allowlisted subscription environment', async () => {
    const preserved = {
      HOME: directory, PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
      CODEX_HOME: join(directory, 'codex-config'), XDG_CONFIG_HOME: join(directory, 'xdg'),
      HTTPS_PROXY: 'http://127.0.0.1:12345', no_proxy: 'localhost',
    }
    const stripped = {
      COMMANDO_TOKEN: 'synthetic-owner', COMMANDO_HOOK_TOKEN: 'synthetic-hook', COMMANDO_CLAUDE_CLI: '/not-forwarded',
      ANTHROPIC_API_KEY: 'synthetic-key', OPENAI_API_KEY: 'synthetic-key', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-token',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-token', ANTHROPIC_BASE_URL: 'https://invalid.example',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
      AWS_ACCESS_KEY_ID: 'synthetic-key', GOOGLE_APPLICATION_CREDENTIALS: '/not-read',
      NODE_OPTIONS: '--require=/not-loaded', BASH_ENV: '/not-loaded', DYLD_INSERT_LIBRARIES: '/not-loaded',
    }
    for (const [key, value] of Object.entries({ ...preserved, ...stripped })) vi.stubEnv(key, value)
    const args = ['--cloud', 'session_safe', '$(touch never)', '; exit 42', '--system-prompt=ignore', 'a b', '"quoted"']
    const input = '--system-prompt malicious\n$(touch never)\nUnicode: 🌥️'
    const result = await runCloudCli({ executable, args: ['inspect', JSON.stringify(Object.keys({ ...preserved, ...stripped })), ...args], cwd: directory, stdin: input })
    expect(result).toMatchObject({ spawned: true, exitCode: 0, timedOut: false, truncated: false, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual({ argv: args, cwd: await realpath(directory), input, env: {
      ...preserved, ...Object.fromEntries(Object.keys(stripped).map((key) => [key, null])),
    } })
  })

  it('does not treat the executable string as a shell command', async () => {
    expect(await runCloudCli({ executable: `${executable} ; exit 0`, args: [] })).toMatchObject({ spawned: false, stdout: '', stderr: '' })
  })

  it.each([true, false])('isolates concurrent Team, Max and inherited child environments (parent configured: %s)', async (configured) => {
    const inherited = configured ? join(directory, 'inherited-profile') : undefined
    const maxConfig = join(directory, 'max profile')
    vi.stubEnv('CLAUDE_CONFIG_DIR', inherited)
    vi.stubEnv('HOME', directory)
    vi.stubEnv('CODEX_HOME', join(directory, 'codex'))
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-stripped-key')
    vi.stubEnv('COMMANDO_TOKEN', 'synthetic-stripped-token')
    const keys = ['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'COMMANDO_TOKEN']
    const parent = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    const pending = [null, maxConfig, undefined].map((claudeConfigDir) => runCloudCli({
      executable, args: ['inspect', JSON.stringify(keys)], claudeConfigDir,
    }))
    // Check both while children are in flight and after all have completed.
    expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(parent)
    const results = await Promise.all(pending)
    expect(Object.fromEntries(keys.map((key) => [key, process.env[key]]))).toEqual(parent)
    for (const [index, result] of results.entries()) {
      expect(result).toMatchObject({ spawned: true, exitCode: 0, stderr: '', truncated: false })
      expect(JSON.parse(result.stdout).env).toEqual({
        CLAUDE_CONFIG_DIR: [null, maxConfig, inherited ?? null][index],
        HOME: directory, PATH: parent.PATH, CODEX_HOME: parent.CODEX_HOME,
        ANTHROPIC_API_KEY: null, COMMANDO_TOKEN: null,
      })
    }
  })

  it.each(['', ' ', 'relative/profile', './claude', '~/.claudep', '/absolute\0profile'])('rejects malformed Claude config paths before spawning: %j', async (claudeConfigDir) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, 'parent-profile'))
    const parent = process.env.CLAUDE_CONFIG_DIR
    expect(await runCloudCli({ executable, args: ['inspect', '["CLAUDE_CONFIG_DIR"]'], claudeConfigDir })).toMatchObject({
      spawned: false, exitCode: null, stdout: '', stderr: '', timedOut: false,
    })
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(parent)
  })

  it.each([
    { executable: '/definitely-missing-cloud-cli', args: [] },
    { executable: 'invalid\0file', args: [] },
    { executable: process.execPath, args: ['bad\0argument'] },
    { executable: process.execPath, args: [], cwd: '/definitely-missing-cwd' },
    { executable: process.execPath, args: [], stdin: 'x'.repeat(64 * 1024 + 1) },
    { executable: process.execPath, args: [], timeoutMs: NaN },
    { executable: process.execPath, args: [], maxOutputBytes: Infinity },
  ])('settles safely for invalid input or spawn failure %#', async (request) => {
    await expect(runCloudCli(request)).resolves.toMatchObject({ spawned: false, stdout: '', stderr: '', exitCode: null })
  })

  it('does not spawn when already aborted', async () => {
    const signal = AbortSignal.abort()
    expect(await runCloudCli({ executable, args: ['hang'], signal })).toMatchObject({ spawned: false, timedOut: false })
  })

  it('sends SIGKILL after the grace period when SIGTERM is ignored', async () => {
    const result = await abortReadyProcess('hang', undefined, 'x'.repeat(64 * 1024))
    expect(result).toMatchObject({ spawned: true, stdout: 'ready', timedOut: false, signal: 'SIGKILL', truncated: false })
  }, 10_000)

  it('does not escalate after a cooperative process has exited', async () => {
    const result = await abortReadyProcess('cooperative')
    expect(result).toMatchObject({ spawned: true, stdout: 'ready', timedOut: false, exitCode: 0, signal: null })
  }, 10_000)

  it('enforces the timeout independently of whether the child has finished startup', async () => {
    const result = await runCloudCli({ executable, args: ['hang'], timeoutMs: 1 })
    expect(result).toMatchObject({ spawned: true, timedOut: true })
    // Startup may or may not install the handler before the deadline. Both
    // terminations are correct; readiness-specific escalation is tested above.
    expect(['SIGTERM', 'SIGKILL']).toContain(result.signal)
  })

  it('settles an abort in the spawn-event race without leaving a child running', async () => {
    const controller = new AbortController()
    const pending = runCloudCli({ executable, args: ['hang'], signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ spawned: true, timedOut: false, signal: 'SIGTERM' })
  })

  it('aborts a running process and removes the abort listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect(await abortReadyProcess('hang', controller)).toMatchObject({ spawned: true, stdout: 'ready', timedOut: false, signal: 'SIGKILL' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  }, 10_000)

  it('caps combined stdout/stderr bytes and stops excessive output, including partial UTF-8', async () => {
    const result = await runCloudCli({ executable, args: ['overflow'], maxOutputBytes: 101 })
    expect(result.spawned).toBe(true)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(101)
    expect(result.stdout).not.toContain('�')
  })

  it('settles when stdin is closed early instead of leaving an unhandled EPIPE', async () => {
    expect(await runCloudCli({ executable, args: ['early-exit'], stdin: 'x'.repeat(64 * 1024) })).toMatchObject({ spawned: true, exitCode: 7, stderr: 'synthetic diagnostic' })
  })

  it('bounds draining after exit when a descendant retains the output pipes', async () => {
    // truncated:true proves the bounded drain fired instead of waiting for pipe
    // EOF; wall time also includes unrelated process-startup scheduling delays.
    expect(await runCloudCli({ executable, args: ['inherited-pipes'] })).toMatchObject({ spawned: true, stdout: 'parent exited', exitCode: 0, truncated: true, timedOut: false })
  })

  it('preserves a complete receipt emitted before a late abort', async () => {
    const result = await abortReadyProcess('receipt-then-hang')
    expect(result).toMatchObject({ timedOut: false, signal: 'SIGKILL', truncated: false })
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, session_id: 'session_synthetic' })
  }, 10_000)
})
