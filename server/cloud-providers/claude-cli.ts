import { homedir } from 'node:os'
import { performance } from 'node:perf_hooks'
import {
  CLOUD_PROMPT_LIMIT, cloudProviderHome, cloudTaskUrl, validCloudRemoteId,
  type CloudCreateInput, type CloudDiff, type CloudProviderInfo, type CloudTask,
} from '../../shared/cloud-tasks.js'
import {
  CloudTaskError, type CloudCliResult, type CloudCliRunner, type CloudDispatchResult,
  type CloudInspection, type CloudProviderAdapter,
} from '../cloud-provider.js'
import { runCloudCli } from '../cloud-cli-runner.js'

const VERSION_CACHE_MS = 5_000
const SOURCE_POLICY_REASON = 'Claude creation is disabled: no documented enforceable no-bundle source policy has been verified. Create in Claude, then link the session locally.'
const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const VERSION_PATTERN = /^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?: \(Claude Code\))?$/

type Options = {
  runner?: CloudCliRunner
  executable?: string
  verifiedVersion?: string
  credentialContextId?: string
}
type Probe = { version: string | null; readiness: CloudProviderInfo['readiness']; reason: string }

function rejected(code: string, message: string): CloudDispatchResult {
  return { state: 'rejected', issue: { code, message } }
}

function unknown(): CloudDispatchResult {
  return { state: 'delivery_unknown', issue: {
    code: 'delivery_unknown', message: 'Message delivery is unknown. Check Claude before retrying; do not automatically resend.',
  } }
}

function parseObject(output: string): Record<string, unknown> | null {
  if (Buffer.byteLength(output) > 64 * 1024) return null
  try {
    const value: unknown = JSON.parse(output)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    // The documented envelope is flat (string/boolean values). Tokenize that
    // small grammar so JSON.parse's last-key-wins cannot accept conflicting IDs
    // or an earlier ok:false hidden by a duplicate ok:true.
    const body = output.trim().slice(1, -1)
    const property = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|true|false)\s*(,|$)/gy
    const keys = new Set<string>()
    let position = 0
    while (position < body.length) {
      const match = property.exec(body)
      if (!match || keys.has(JSON.parse(match[1]))) return null
      keys.add(JSON.parse(match[1]))
      position = property.lastIndex
    }
    return value as Record<string, unknown>
  } catch { return null }
}

/** Public CLI only. Version verification is a local P0b operator attestation,
 * not an account check; the service must confirm the current account per send. */
export class ClaudeCloudAdapter implements CloudProviderAdapter {
  readonly id = 'claude' as const
  private readonly runner: CloudCliRunner
  private readonly executable: string
  private readonly verifiedVersion: string | undefined
  private readonly credentialContextId: string
  private probeCache?: { expiresAt: number; value: Probe }
  private probeFlight?: Promise<Probe>

  constructor(options: Options = {}) {
    this.runner = options.runner ?? runCloudCli
    this.executable = options.executable ?? process.env.COMMANDO_CLAUDE_CLI ?? 'claude'
    this.verifiedVersion = options.verifiedVersion ?? process.env.COMMANDO_CLOUD_CLAUDE_VERIFIED_VERSION
    this.credentialContextId = options.credentialContextId ?? process.env.COMMANDO_CLOUD_CLAUDE_CONTEXT ?? 'claude-default'
  }

  private probe(): Promise<Probe> {
    if (this.probeCache && performance.now() < this.probeCache.expiresAt) return Promise.resolve(this.probeCache.value)
    if (this.probeFlight) return this.probeFlight
    this.probeFlight = this.detectVersion().then((value) => {
      this.probeCache = { value, expiresAt: performance.now() + VERSION_CACHE_MS }
      return value
    }).finally(() => { this.probeFlight = undefined })
    return this.probeFlight
  }

  private async detectVersion(): Promise<Probe> {
    let result: CloudCliResult
    try {
      result = await this.runner({ executable: this.executable, args: ['--version'], cwd: homedir(), timeoutMs: 3_000, maxOutputBytes: 4_096 })
    } catch {
      return { version: null, readiness: 'error', reason: 'Unable to check the Claude CLI version.' }
    }
    if (!result.spawned) return { version: null, readiness: 'missing_cli', reason: 'Claude CLI could not be started. Install or configure it locally, then verify cloud follow-up support.' }
    const version = !result.timedOut && !result.truncated && result.exitCode === 0 && !result.signal
      && Buffer.byteLength(result.stdout) <= 4_096
      ? VERSION_PATTERN.exec(result.stdout.trim())?.[1] ?? null : null
    if (!version) return { version: null, readiness: 'error', reason: 'Claude CLI version probe did not return a recognized version.' }
    if (!CONTEXT_PATTERN.test(this.credentialContextId)) return { version, readiness: 'error', reason: 'Configure a valid non-secret Claude credential-context identifier.' }
    if (!this.verifiedVersion || this.verifiedVersion !== version) return {
      version, readiness: 'unverified', reason: 'Installed Claude CLI version has not been explicitly verified for cloud follow-up. Linking is user-supplied and unverified.',
    }
    return { version, readiness: 'ready', reason: 'Cloud follow-up is enabled for the exact locally verified CLI version. Confirm the current subscription account before every message; account identity is unverified.' }
  }

  async info(): Promise<CloudProviderInfo> {
    const probe = await this.probe()
    return {
      id: this.id, label: 'Claude', homeUrl: cloudProviderHome(this.id),
      readiness: probe.readiness, reason: `${probe.reason} Local links are user-supplied, not provider-verified. ${SOURCE_POLICY_REASON}`,
      version: probe.version, credentialContextId: this.credentialContextId, verifiedAccountRef: null,
      capabilities: { create: false, link: true, list: false, inspect: false,
        sendMessage: probe.readiness === 'ready', diff: false, accountIdentity: false },
    }
  }

  async create(_input: CloudCreateInput, _signal?: AbortSignal): Promise<CloudDispatchResult> {
    return rejected('source_policy_unverified', SOURCE_POLICY_REASON)
  }

  async sendMessage(task: CloudTask, message: string, signal?: AbortSignal): Promise<CloudDispatchResult> {
    if (task.provider !== this.id || !validCloudRemoteId(this.id, task.providerTaskId)) {
      return rejected('invalid_provider_task', 'A valid linked Claude session ID is required.')
    }
    if (!CONTEXT_PATTERN.test(this.credentialContextId) || task.credentialContextId !== this.credentialContextId
      || task.verifiedAccountRef !== null) {
      return rejected('credential_context_mismatch', 'Reconfirm this task in the current unverified Claude account context before sending.')
    }
    if (typeof message !== 'string' || !message.trim() || message.length > CLOUD_PROMPT_LIMIT || message.includes('\0')) {
      return rejected('invalid_message', 'Provide a nonempty message within the cloud prompt limit.')
    }
    if (signal?.aborted) return rejected('aborted', 'Message cancelled before dispatch.')
    const info = await this.info()
    if (!info.capabilities.sendMessage) return rejected(info.readiness === 'missing_cli' ? 'missing_cli' : 'capability_unverified', info.reason)
    if (signal?.aborted) return rejected('aborted', 'Message cancelled before dispatch.')

    let result: CloudCliResult
    try {
      result = await this.runner({
        executable: this.executable,
        // The prompt never occupies an option position (including leading '-' text).
        args: ['-p', '--cloud', task.providerTaskId, '--output-format', 'json'],
        stdin: message, cwd: homedir(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024, signal,
      })
    } catch { return unknown() }
    if (!result.spawned) return rejected('cli_not_started', 'Claude CLI did not start; no message was dispatched.')
    if (result.truncated) return unknown()
    const receipt = parseObject(result.stdout)
    if (!receipt || receipt.session_id !== task.providerTaskId) return unknown()
    const providerUrl = cloudTaskUrl(this.id, task.providerTaskId)
    // Only the exact canonical task URL or documented CLI tracking suffix is
    // accepted. Never persist credentials, arbitrary query strings or redirects.
    if (Object.keys(receipt).length === 3 && receipt.ok === true
      && (receipt.url === providerUrl || receipt.url === `${providerUrl}?from=cli&m=0`)) {
      return { state: 'accepted', receipt: { providerTaskId: task.providerTaskId, providerUrl, evidence: 'provider_receipt' } }
    }
    // A complete documented failed-send envelope is authoritative. Stderr, exit
    // status and free-form text are not; an interrupted attempt remains unknown.
    if (!result.timedOut && !result.signal && !signal?.aborted && Object.keys(receipt).length === 3
      && receipt.ok === false && typeof receipt.error === 'string'
      && receipt.error.trim() && !('url' in receipt)) {
      return rejected('provider_rejected', 'Claude reported that the message was not delivered. Check access and session availability in Claude.')
    }
    return unknown()
  }

  async inspect(_task: CloudTask, _signal?: AbortSignal): Promise<CloudInspection> {
    throw new CloudTaskError(501, 'unsupported', 'Live session status is only available in Claude; no verified read-only CLI interface is supported.')
  }

  async diff(_task: CloudTask, _signal?: AbortSignal): Promise<CloudDiff> {
    throw new CloudTaskError(501, 'unsupported', 'View changes in Claude; no verified read-only CLI diff interface is supported.')
  }
}
