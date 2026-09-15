import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { CloudCliRequest, CloudCliResult, CloudCliRunner } from './cloud-provider.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_INPUT_BYTES = 64 * 1024
const TERMINATION_GRACE_MS = 250
const DRAIN_GRACE_MS = 100

// Construct, never spread, the environment. In particular no COMMANDO_*, API keys,
// provider selectors/base URLs, OAuth tokens, NODE_OPTIONS or loader injection.
// Subscription credentials remain in the CLI's own store; we never read that store.
const ENV_KEYS = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const

function cliEnvironment(request: CloudCliRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  // Unset and an explicit ~/.claude path are different CLI credential contexts.
  // Apply the per-instance selection only to this child's fresh environment.
  if (request.claudeConfigDir === null) delete env.CLAUDE_CONFIG_DIR
  else if (request.claudeConfigDir !== undefined) env.CLAUDE_CONFIG_DIR = request.claudeConfigDir
  return env
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined ? fallback : Math.max(1, Math.min(maximum, Math.floor(value)))
}

/** Internal daemon primitive: executable/argv must come from a provider adapter,
 * never HTTP input. Only the named Claude config selection is supported, not an
 * arbitrary environment override or shell command. */
export const runCloudCli: CloudCliRunner = (request) => new Promise((resolve) => {
  const result: CloudCliResult = {
    stdout: '', stderr: '', exitCode: null, signal: null,
    spawned: false, timedOut: false, truncated: false,
  }
  // Invalid local configuration and cancelled-before-spawn are definite non-dispatch.
  if (request.signal?.aborted || !request.executable || request.executable.includes('\0')
    || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    || request.cwd?.includes('\0')
    || (request.claudeConfigDir !== undefined && request.claudeConfigDir !== null
      && (typeof request.claudeConfigDir !== 'string' || !isAbsolute(request.claudeConfigDir)
        || request.claudeConfigDir.includes('\0')))
    || Buffer.byteLength(request.stdin ?? '') > MAX_INPUT_BYTES
    || request.args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 128 * 1024
    || (request.timeoutMs !== undefined && !Number.isFinite(request.timeoutMs))
    || (request.maxOutputBytes !== undefined && !Number.isFinite(request.maxOutputBytes))) {
    resolve(result)
    return
  }

  const timeoutMs = bounded(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxOutput = bounded(request.maxOutputBytes, 1024 * 1024, MAX_OUTPUT_BYTES)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(request.executable, request.args, {
      cwd: request.cwd, shell: false, windowsHide: true,
      env: cliEnvironment(request), stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    resolve(result)
    return
  }

  let settled = false
  let exited = false
  let stopping = false
  let outputBytes = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let deadline: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined

  const finish = () => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    clearTimeout(killTimer)
    clearTimeout(drainTimer)
    request.signal?.removeEventListener('abort', abort)
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    // Decoding a cut UTF-8 sequence adds a replacement character. Drop a trailing
    // partial character so the returned strings respect the combined byte bound.
    const decode = (chunks: Buffer[]) => {
      const bytes = Buffer.concat(chunks)
      const text = new StringDecoder('utf8').write(bytes)
      return Buffer.byteLength(text) > bytes.length
        ? new StringDecoder('utf8').write(Buffer.from(text).subarray(0, bytes.length)) : text
    }
    result.stdout = decode(stdout)
    result.stderr = decode(stderr)
    resolve(result)
  }
  const kill = (signal: NodeJS.Signals) => {
    // Never signal a numeric PID after exit/reaping (PID reuse), and never use
    // child.killed: it only says a prior signal was sent, not that the child died.
    if (!exited && result.spawned && child.exitCode === null && child.signalCode === null) {
      try { child.kill(signal) } catch { /* bounded settlement still applies */ }
    }
  }
  const stop = () => {
    if (settled || stopping) return
    stopping = true
    child.stdin?.destroy()
    kill('SIGTERM')
    killTimer = setTimeout(() => {
      kill('SIGKILL')
      // A descendant may retain inherited pipes. Never wait for those forever.
      drainTimer = setTimeout(() => { result.truncated = true; finish() }, DRAIN_GRACE_MS)
    }, TERMINATION_GRACE_MS)
  }
  const abort = () => stop()
  const collect = (chunks: Buffer[], chunk: Buffer) => {
    if (settled) return
    const remaining = maxOutput - outputBytes
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining)
      chunks.push(kept)
      outputBytes += kept.length
    }
    if (chunk.length > remaining) {
      result.truncated = true
      stop()
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk))
  child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk))
  child.stdout?.on('error', () => { result.truncated = true; stop() })
  child.stderr?.on('error', () => { result.truncated = true; stop() })
  // EPIPE is normal when a CLI rejects input or exits before consuming stdin.
  child.stdin?.on('error', () => stop())
  child.on('spawn', () => {
    result.spawned = true
    if (stopping || request.signal?.aborted) {
      kill('SIGTERM')
      stop()
    } else {
      child.stdin?.end(request.stdin ?? '')
    }
  })
  child.on('error', () => {
    if (!result.spawned) finish()
    else stop()
  })
  child.on('exit', (code, signal) => {
    exited = true
    if (settled) return
    result.exitCode = code
    result.signal = signal
    clearTimeout(killTimer)
    clearTimeout(drainTimer)
    drainTimer = setTimeout(() => { result.truncated = true; finish() }, DRAIN_GRACE_MS)
  })
  child.on('close', (code, signal) => {
    if (settled) return
    result.exitCode = code
    result.signal = signal
    finish()
  })
  deadline = setTimeout(() => { result.timedOut = true; stop() }, timeoutMs)
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) abort()
})

// Keep the named frozen contract and support the Codex worker's default import.
export default runCloudCli
