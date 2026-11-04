import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import type { CloudSource, CloudReceipt } from '../../shared/cloud-tasks.js'
import { cliEnvironment, runCloudCli } from '../cloud-cli-runner.js'
import { CloudTaskError, type CloudCliRunner, type CloudDispatchResult } from '../cloud-provider.js'

export const TRUST_PROMPT = 'Quick safety check: Is this a project you created or one you trust?'
export type ClaudeCreateOptions = {
  runner?: CloudCliRunner
  timeoutMs?: number
  pollMs?: number
}
const reject = (code: string, message: string): CloudDispatchResult => ({ state: 'rejected', issue: { code, message } })
const unknown = (): CloudDispatchResult => ({ state: 'delivery_unknown', issue: {
  code: 'delivery_unknown', message: 'Claude acceptance is unknown. Check Claude before submitting again.',
} })
const succeeded = (result: Awaited<ReturnType<CloudCliRunner>>) => result.spawned && result.exitCode === 0 && !result.signal && !result.timedOut && !result.truncated

/** Accept only credential-free GitHub transports; never local paths or remote helpers. */
export function githubRemote(value: string): string | null {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value) ? value : null
}

/** Resolve pushed source before journaling it; never inspect or upload working files. */
export async function resolveClaudeSource(source: CloudSource, runner: CloudCliRunner = runCloudCli): Promise<CloudSource> {
  if (!source.checkoutPath || !isAbsolute(source.checkoutPath) || !source.branch
    || source.branch.startsWith('-') || source.branch.length > 255) throw new CloudTaskError(400, 'source_unverified', 'An existing checkout and explicit remote branch are required.')
  const git = async (args: string[]) => {
    const result = await runner({ executable: 'git', args, cwd: source.checkoutPath, timeoutMs: 15_000, maxOutputBytes: 4096 })
    if (!succeeded(result)) throw new CloudTaskError(400, 'source_unverified', 'Unable to verify the GitHub remote branch with the daemon’s Git credentials.')
    return result.stdout.trim()
  }
  await git(['check-ref-format', `refs/heads/${source.branch}`])
  const remoteUrl = githubRemote(await git(['remote', 'get-url', 'origin']))
  if (!remoteUrl) throw new CloudTaskError(400, 'source_unverified', 'The selected checkout needs a credential-free GitHub origin URL.')
  const ref = `refs/heads/${source.branch}`
  const output = await git(['ls-remote', '--exit-code', '--heads', '--', remoteUrl, ref])
  const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t([^\r\n]+)$/.exec(output)
  if (!match || match[2] !== ref) throw new CloudTaskError(400, 'source_unverified', 'The requested branch was not found on the GitHub remote.')
  return { checkoutPath: source.checkoutPath, branch: source.branch, remoteUrl, commit: match[1] }
}

/** Require a complete, adjacent three-line receipt, with matching URL/resume IDs. */
export function claudeCreateReceipt(screen: string): CloudReceipt | null {
  const plain = stripVTControlCharacters(screen).replace(/\r\n/g, '\n')
  const matches = [...plain.matchAll(/^Created cloud session: [^\n\x00-\x1f]+\nView: https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]{10,64})(?:\?from=cli&m=0)?\nResume with: claude --teleport (session_[A-Za-z0-9]{10,64})\n/gm)]
  if (matches.length !== 1 || matches[0][1] !== matches[0][2]
    || plain.split('\n').filter((line) => line.startsWith('View: ') || line.startsWith('Created cloud session: ') || line.startsWith('Resume with: ')).length !== 3) return null
  return { providerTaskId: matches[0][1], providerUrl: `https://claude.ai/code/${matches[0][1]}`, evidence: 'provider_receipt' }
}

/** Only called after the service has durably claimed dispatch. No user's tmux socket is used. */
export async function createClaudeSession(source: CloudSource, prompt: string, executable: string, configDir: string | null | undefined,
  signal?: AbortSignal, options: ClaudeCreateOptions = {}): Promise<CloudDispatchResult> {
  const run = options.runner ?? runCloudCli
  const socket = `commando-cloud-create-${randomUUID()}`
  const session = 'create'
  let tmuxConfig = '/dev/null'
  const tmux = (args: string[], cancellable = true) => run({ executable: 'tmux', args: ['-L', socket, '-f', tmuxConfig, ...args],
    timeoutMs: 3000, maxOutputBytes: 64 * 1024, signal: cancellable ? signal : undefined })
  let scratch: string | undefined
  let mayHaveStarted = false
  try {
    if (signal?.aborted) return reject('dispatch_aborted', 'Cancelled before dispatch.')
    if (!succeeded(await tmux(['-V']))) return reject('cli_not_started', 'Private tmux could not be started.')
    if (!source.remoteUrl || !githubRemote(source.remoteUrl) || !source.branch || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit ?? '')) {
      return reject('source_unverified', 'A verified GitHub remote branch and commit are required.')
    }
    scratch = await mkdtemp(join(tmpdir(), 'commando-cloud-create-'))
    await chmod(scratch, 0o700)
    scratch = await realpath(scratch)
    const checkout = join(scratch, 'checkout')
    // Do not let a global URL rewrite turn this into a local clone, or a local
    // checkout hook copy working files into the clone before Claude sees it.
    const clone = await run({ executable: 'git', args: ['-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'core.hooksPath=/dev/null', 'clone', '--template=', '--depth', '1', '--branch', source.branch, '--', source.remoteUrl, checkout],
      cwd: scratch, timeoutMs: 45_000, maxOutputBytes: 4096, signal })
    if (!succeeded(clone)) return reject('source_unverified', 'The remote branch could not be cloned; Claude was not started.')
    const head = await run({ executable: 'git', args: ['rev-parse', 'HEAD'], cwd: checkout, timeoutMs: 3000, maxOutputBytes: 4096, signal })
    if (!succeeded(head) || head.stdout.trim() !== source.commit) return reject('source_changed', 'The remote branch changed. Review a new intent before submitting.')
    if (signal?.aborted) return reject('dispatch_aborted', 'Cancelled before dispatch.')
    // The private server reads this fixed config BEFORE new-session, retaining
    // even a CLI that emits its receipt and exits before our first capture.
    tmuxConfig = join(scratch, 'tmux.conf')
    await writeFile(tmuxConfig, 'set-option -gw remain-on-exit on\n', { mode: 0o600 })
    const env = { ...cliEnvironment({ executable, args: [], claudeConfigDir: configDir }), TERM: 'xterm-256color' }
    // Multiple command arguments make tmux exec argv directly. No shell ever sees the prompt.
    mayHaveStarted = true
    const launch = await tmux(['new-session', '-d', '-s', session, '-x', '240', '-y', '60', '-c', checkout,
      '/usr/bin/env', '-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), executable, '--cloud', prompt])
    if (!launch.spawned) return reject('cli_not_started', 'Private tmux could not be started.')
    if (!succeeded(launch)) return unknown()
    const deadline = performance.now() + Math.min(options.timeoutMs ?? 120_000, 120_000)
    let trusted = false
    while (!signal?.aborted && performance.now() < deadline) {
      const capture = await tmux(['capture-pane', '-p', '-J', '-t', `${session}:0.0`, '-S', '-200'])
      if (!succeeded(capture)) return unknown()
      const receipt = claudeCreateReceipt(capture.stdout)
      if (receipt) return { state: 'accepted', receipt }
      const screen = stripVTControlCharacters(capture.stdout)
      if (!trusted && screen.split(/\r?\n/).some((line) => line.trim().startsWith(TRUST_PROMPT))
        && screen.includes('❯ No, exit') && screen.includes('Yes, I trust this folder')) {
        const cwd = await tmux(['display-message', '-p', '-t', `${session}:0.0`, '#{pane_current_path}'])
        if (!succeeded(cwd) || !isAbsolute(cwd.stdout.trim())
          || await realpath(cwd.stdout.trim()) !== await realpath(checkout)) return unknown()
        trusted = true
        if (!succeeded(await tmux(['send-keys', '-t', `${session}:0.0`, 'Down', 'Enter']))) return unknown()
      }
      const dead = await tmux(['display-message', '-p', '-t', `${session}:0.0`, '#{pane_dead}'])
      if (!succeeded(dead) || dead.stdout.trim() === '1') {
        // Capture again: the receipt may have appeared between capture and pane exit.
        const final = await tmux(['capture-pane', '-p', '-J', '-t', `${session}:0.0`, '-S', '-200'])
        const last = succeeded(final) ? claudeCreateReceipt(final.stdout) : null
        return last ? { state: 'accepted', receipt: last } : unknown()
      }
      await delay(options.pollMs ?? 500, undefined, { signal }).catch(() => {})
    }
    return unknown()
  } catch {
    return mayHaveStarted ? unknown() : reject('cli_not_started', 'Source preparation or private tmux setup failed before Claude started.')
  } finally {
    // Unique socket owns exactly this operation; cleanup never targets shared servers.
    await tmux(['kill-session', '-t', session], false).catch(() => {})
    await tmux(['kill-server'], false).catch(() => {})
    if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => {
      // Cleanup failure must not erase an authoritative receipt or invite a resend.
      console.warn('[cloud] Could not remove a Claude creation scratch directory.')
    })
  }
}
