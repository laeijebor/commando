import { stripVTControlCharacters } from 'node:util'
import {
  CLOUD_DIFF_BYTE_LIMIT, CLOUD_DIFF_LINE_LIMIT, CLOUD_PROMPT_LIMIT,
  cloudProviderHome, cloudTaskUrl, validCloudRemoteId,
  type CloudCreateInput, type CloudDiff, type CloudProviderInfo, type CloudReceipt, type CloudTask,
} from '../../shared/cloud-tasks.js'
import runCloudCli from '../cloud-cli-runner.js'
import {
  CloudTaskError, type CloudCliResult, type CloudCliRunner, type CloudDispatchResult,
  type CloudInspection, type CloudProviderAdapter,
} from '../cloud-provider.js'

const VERSION_BYTES = 1024
const VERSION_PATTERN = /^codex-cli (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?)$/
const RECEIPT_BYTES = 4096
const LIST_BYTES = 256 * 1024
const MAX_PAGES = 5
const READ_TIMEOUT = 15_000

function successful(result: CloudCliResult): boolean {
  return result.spawned && result.exitCode === 0 && !result.signal && !result.timedOut && !result.truncated
}

function reject(code: string, message: string): CloudDispatchResult {
  return { state: 'rejected', issue: { code, message } }
}

function unknownDelivery(): CloudDispatchResult {
  return { state: 'delivery_unknown', issue: {
    code: 'delivery_unknown', message: 'Codex acceptance is unknown. Check Codex before submitting again.',
  } }
}

// This is the entire stdout receipt, never a URL scraped from diagnostic prose.
// Upstream println! terminates the URL with a newline. Require that boundary so
// an interrupted task ID that happens to be syntactically valid is not accepted.
function receipt(stdout: string): CloudReceipt | null {
  if (Buffer.byteLength(stdout) > RECEIPT_BYTES || !stdout.endsWith('\n')) return null
  const value = stdout.replace(/\r?\n$/, '')
  const match = /^https:\/\/chatgpt\.com\/codex\/tasks\/(task_[A-Za-z0-9_-]+)$/.exec(value)
  if (!match || !validCloudRemoteId('codex', match[1])) return null
  const providerTaskId = match[1]
  if (value !== cloudTaskUrl('codex', providerTaskId)) return null
  return { providerTaskId, providerUrl: value, evidence: 'provider_receipt' }
}

function invalidFormat(): CloudTaskError {
  return new CloudTaskError(502, 'codex_output_unrecognized', 'Codex returned an unrecognized task listing.')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type ListTask = { id: string; status: string; updated_at: string }
function parseList(stdout: string): { tasks: ListTask[]; cursor: string | null } {
  if (Buffer.byteLength(stdout) > LIST_BYTES) throw invalidFormat()
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw invalidFormat() }
  if (!record(value) || !Array.isArray(value.tasks) || value.tasks.length > 20) throw invalidFormat()
  if (value.cursor !== null && (typeof value.cursor !== 'string' || !value.cursor.length
    || value.cursor.length > 2048 || /[\x00-\x20\x7f]/.test(value.cursor))) throw invalidFormat()
  const ids = new Set<string>()
  const tasks = value.tasks.map((task: unknown): ListTask => {
    if (!record(task) || !validCloudRemoteId('codex', task.id)
      || task.url !== cloudTaskUrl('codex', task.id)
      || typeof task.status !== 'string' || !task.status.length || task.status.length > 128
      || /[\x00-\x1f\x7f]/.test(task.status)
      || typeof task.updated_at !== 'string' || task.updated_at.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(task.updated_at)
      || !Number.isFinite(Date.parse(task.updated_at)) || ids.has(task.id)) throw invalidFormat()
    ids.add(task.id)
    return { id: task.id, status: task.status, updated_at: task.updated_at }
  })
  return { tasks, cursor: value.cursor as string | null }
}

function normalize(task: ListTask): CloudInspection {
  // Official TaskStatus is pending|ready|applied|error. Pending collapses running,
  // queued AND unrecognized upstream states; it cannot establish any one of them.
  const remoteState = task.status === 'ready' || task.status === 'applied' ? 'result_ready'
    : task.status === 'error' ? 'failed' : 'unknown'
  return { remoteState, rawState: task.status, updatedAt: task.updated_at }
}

function boundedDiff(stdout: string, alreadyTruncated: boolean): CloudDiff {
  // CloudDiff.text is plaintext, rendered via a text node by the client (HTML
  // escaping belongs there). Escape remaining control characters visibly, rather
  // than forwarding terminal escape sequences or turning content into markup.
  const plain = stripVTControlCharacters(stdout).replace(/\r\n/g, '\n')
  const parts: string[] = []
  let bytes = 0
  let lines = 1
  let truncated = alreadyTruncated
  for (const char of plain) {
    const code = char.codePointAt(0)!
    const text = (code < 32 && char !== '\n' && char !== '\t') || (code >= 127 && code <= 159)
      ? `\\u${code.toString(16).padStart(4, '0')}` : char
    const size = Buffer.byteLength(text)
    if (bytes + size > CLOUD_DIFF_BYTE_LIMIT || (char === '\n' && lines >= CLOUD_DIFF_LINE_LIMIT)) {
      truncated = true
      break
    }
    parts.push(text)
    bytes += size
    if (char === '\n') lines++
  }
  return { text: parts.join(''), truncated }
}

/** Provisional source-grounded adapter; authenticated P0 evidence is still pending. */
export class CodexCloudAdapter implements CloudProviderAdapter {
  readonly id = 'codex' as const
  private readonly runner: CloudCliRunner
  private readonly executable: string
  private readonly verifiedVersion: string | undefined
  private readonly credentialContextId: string

  constructor(options: { runner?: CloudCliRunner; executable?: string; verifiedVersion?: string; credentialContextId?: string } = {}) {
    this.runner = options.runner ?? runCloudCli
    this.executable = options.executable ?? process.env.COMMANDO_CODEX_CLI ?? 'codex'
    this.verifiedVersion = options.verifiedVersion ?? process.env.COMMANDO_CLOUD_CODEX_VERIFIED_VERSION
    this.credentialContextId = options.credentialContextId ?? process.env.COMMANDO_CLOUD_CODEX_CONTEXT ?? 'codex:default'
  }

  async info(): Promise<CloudProviderInfo> {
    let readiness: CloudProviderInfo['readiness'] = 'error'
    let version: string | null = null
    let reason = 'Unable to inspect the Codex CLI version.'
    try {
      const result = await this.runner({ executable: this.executable, args: ['--version'], timeoutMs: 5000, maxOutputBytes: VERSION_BYTES })
      if (!result.spawned) {
        readiness = 'missing_cli'
        reason = 'Codex CLI could not be started. Existing task IDs can still be linked locally.'
      } else if (successful(result) && Buffer.byteLength(result.stdout) <= VERSION_BYTES) {
        version = VERSION_PATTERN.exec(result.stdout.trim())?.[1] ?? null
        if (version !== null) {
          readiness = this.verifiedVersion === version ? 'ready' : 'unverified'
          reason = readiness === 'ready'
            ? 'CLI version matches the configured verification gate. Account identity is unverified; confirm the current Codex account before submission.'
            : 'Codex cloud capabilities require P0 verification and an exact configured CLI version match.'
        }
      }
    } catch { /* Do not expose runner diagnostics or credential output. */ }
    const enabled = readiness === 'ready'
    return {
      id: this.id, label: 'Codex', homeUrl: cloudProviderHome(this.id), readiness, reason, version,
      credentialContextId: this.credentialContextId, verifiedAccountRef: null,
      capabilities: { create: enabled, link: true, list: enabled, inspect: enabled, diff: enabled, sendMessage: false, accountIdentity: false },
    }
  }

  async create(input: CloudCreateInput, signal?: AbortSignal): Promise<CloudDispatchResult> {
    if (input.provider !== this.id || !input.accountConfirmed) {
      return reject('account_confirmation_required', 'Confirm the current Codex account before submitting.')
    }
    if (input.credentialContextId !== this.credentialContextId) {
      return reject('credential_context_mismatch', 'Reconfirm this draft in the current Codex credential context before submitting.')
    }
    const { environmentId, branch } = input.source
    if (!environmentId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(environmentId)) {
      return reject('invalid_environment', 'A Codex environment ID is required.')
    }
    if (!branch || branch.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/')
      || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
      return reject('invalid_branch', 'An explicit valid branch is required.')
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt === '-' || input.prompt.length > CLOUD_PROMPT_LIMIT
      || input.prompt.includes('\0')) return reject('invalid_prompt', 'A bounded nonempty task prompt is required.')
    // Freeze all argv before awaiting discovery; repository/checkout/commit are
    // metadata only. No cwd, git push, bundle, local exec, or apply is dispatched.
    const args = ['cloud', 'exec', '--env', environmentId, '--branch', branch, '--', input.prompt]
    if (!(await this.info()).capabilities.create) return reject('codex_unverified', 'Codex creation is unavailable until the CLI version is verified.')
    if (signal?.aborted) return reject('dispatch_aborted', 'Submission was cancelled before dispatch.')
    let result: CloudCliResult
    try {
      result = await this.runner({ executable: this.executable, args, timeoutMs: 60_000, maxOutputBytes: RECEIPT_BYTES, signal })
    } catch { return unknownDelivery() }
    if (!result.spawned) return reject('cli_not_started', 'Codex could not be started; no task was dispatched.')
    // A complete provider receipt outranks later local exit/timeout/signal
    // failure. Truncated output cannot establish an unambiguous receipt.
    const accepted = !result.truncated ? receipt(result.stdout) : null
    return accepted ? { state: 'accepted', receipt: accepted } : unknownDelivery()
  }

  async sendMessage(_task: CloudTask, _message: string, _signal?: AbortSignal): Promise<CloudDispatchResult> {
    return reject('unsupported', 'Codex CLI does not support cloud follow-up messages. Continue in Codex.')
  }

  private taskId(task: CloudTask): string {
    if (task.provider !== this.id || !validCloudRemoteId(this.id, task.providerTaskId)) {
      throw new CloudTaskError(400, 'invalid_task_id', 'A valid Codex task ID is required.')
    }
    if (task.credentialContextId !== this.credentialContextId) {
      throw new CloudTaskError(409, 'credential_context_mismatch', 'This task belongs to a different Codex credential context.')
    }
    return task.providerTaskId
  }

  private async requireRead(signal?: AbortSignal): Promise<void> {
    if (!(await this.info()).capabilities.inspect) {
      throw new CloudTaskError(503, 'codex_unverified', 'Codex reads are unavailable until the CLI version is verified.')
    }
    if (signal?.aborted) throw new CloudTaskError(503, 'read_aborted', 'Codex read was cancelled.')
  }

  private async read(args: string[], maxOutputBytes: number, signal?: AbortSignal): Promise<CloudCliResult> {
    if (signal?.aborted) throw new CloudTaskError(503, 'read_aborted', 'Codex read was cancelled.')
    try { return await this.runner({ executable: this.executable, args, timeoutMs: READ_TIMEOUT, maxOutputBytes, signal }) }
    catch { throw new CloudTaskError(502, 'codex_read_failed', 'Codex could not be read. Check the CLI account and connection.') }
  }

  async inspect(task: CloudTask, signal?: AbortSignal): Promise<CloudInspection> {
    const id = this.taskId(task)
    await this.requireRead(signal)
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = ['cloud', 'list', '--json', '--limit', '20']
      // Equals form prevents a provider-controlled cursor from becoming an option.
      if (cursor !== null) args.push(`--cursor=${cursor}`)
      const result = await this.read(args, LIST_BYTES, signal)
      if (!successful(result)) throw new CloudTaskError(502, 'codex_read_failed', 'Codex task listing is unavailable.')
      const listing = parseList(result.stdout)
      const match = listing.tasks.find(item => item.id === id)
      if (match) return normalize(match)
      cursor = listing.cursor
      if (cursor === null) throw new CloudTaskError(404, 'task_not_observed', 'This exact task was not present in the Codex listing. Its remote state is unknown.')
      if (seen.has(cursor)) throw new CloudTaskError(502, 'codex_cursor_repeated', 'Codex repeated a listing cursor; task observation is unavailable.')
      seen.add(cursor)
    }
    throw new CloudTaskError(503, 'codex_scan_limit', 'The bounded Codex listing did not locate this task. Open it in Codex.')
  }

  async diff(task: CloudTask, signal?: AbortSignal): Promise<CloudDiff> {
    const id = this.taskId(task)
    await this.requireRead(signal)
    const result = await this.read(['cloud', 'diff', id], CLOUD_DIFF_BYTE_LIMIT, signal)
    // A runner may terminate on the output cap. Only that explicit truncation
    // allows partial text, never a timeout or an ordinary unsuccessful read.
    if (signal?.aborted || !result.spawned || result.timedOut || (!result.truncated && !successful(result))) {
      throw new CloudTaskError(502, 'codex_diff_unavailable', 'Codex diff is unavailable. Open the task in Codex.')
    }
    return boundedDiff(result.stdout, result.truncated)
  }
}
