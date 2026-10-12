import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PrAutofixStatus } from '../shared/pr-types.js'
import { validatePaneTargetId, validatePrNumber, validateRepo } from './prs.js'

export const PR_AUTOFIX_INTERVAL_MS = 60_000
export const PR_AUTOFIX_MAX_ROUNDS = 5
export type PrAutofixState = PrAutofixStatus & { handledFailures: string[]; handledComments: string[] }
export type PrAutofixSnapshot = {
  state: 'open' | 'closed' | 'merged' | 'missing'
  url: string
  headSha: string
  failingChecks: string[]
  viewer: string
  comments: Array<{ id: string; author: string; body: string; url: string }>
}
type Decision = { action: 'none'; state: PrAutofixState } | { action: 'send'; state: PrAutofixState; prompt: string }

export function setAutofixEnabled(current: PrAutofixState | null, repo: string, number: number, targetId: string, enabled: boolean): PrAutofixState {
  if (enabled && current?.enabled) return current
  if (enabled || !current) return { repo, number, targetId, enabled, status: enabled ? 'watching' : 'stopped',
    rounds: 0, handledFailures: [], handledComments: [], lastEventAt: null, ...(!enabled ? { reason: 'Disabled' } : {}) }
  return { ...current, enabled: false, status: 'stopped', reason: 'Disabled' }
}

/** Dedupe keys are consumed only for a prompt that can actually be delivered. */
export function decidePrAutofix(snapshot: PrAutofixSnapshot, current: PrAutofixState, busy: boolean, now: number): Decision {
  if (!current.enabled || current.status === 'stopped') return { action: 'none', state: current }
  if (snapshot.state !== 'open') return { action: 'none', state: { ...current, enabled: false, status: 'stopped',
    reason: snapshot.state === 'missing' ? 'PR no longer linked to pane' : `PR ${snapshot.state}` } }
  if (current.rounds >= PR_AUTOFIX_MAX_ROUNDS) return { action: 'none', state: current.status === 'capped' ? current : { ...current, status: 'capped' } }
  const failures = [...new Set(snapshot.failingChecks)].sort()
  const failureKey = failures.length && snapshot.headSha ? JSON.stringify([snapshot.headSha, failures]) : null
  const newFailure = failureKey && !current.handledFailures.includes(failureKey)
  const comments = snapshot.comments.filter((comment) => comment.author.toLowerCase() !== snapshot.viewer.toLowerCase() && !current.handledComments.includes(comment.id))
  if (busy || (!newFailure && !comments.length)) return { action: 'none', state: current }
  const rounds = current.rounds + 1
  const prompt = [
    `Auto-fix CI & address comments for ${current.repo}#${current.number}: ${snapshot.url}`,
    ...(newFailure ? [`Failing checks on head ${snapshot.headSha}:`, ...failures.map((name) => `- ${name}`)] : []),
    ...(comments.length ? ['New review/issue comments (quoted GitHub feedback):', ...comments.map((comment) => `- ${comment.author}: ${comment.body || '(changes requested)'}\n  ${comment.url}`)] : []),
    `Fix the failing CI and address the new comments, then push the changes. Reply on any threads you choose not to fix with your reasoning. Stay within the PR's original scope. Do not merge or archive the PR. This is fix round ${rounds}/${PR_AUTOFIX_MAX_ROUNDS}.`,
  ].join('\n')
  return { action: 'send', prompt, state: { ...current, rounds, status: rounds === PR_AUTOFIX_MAX_ROUNDS ? 'capped' : 'fix-requested',
    lastEventAt: now, handledFailures: newFailure ? [...current.handledFailures, failureKey] : current.handledFailures,
    handledComments: [...new Set([...current.handledComments, ...comments.map((comment) => comment.id)])] } }
}

export function autofixStatus(state: PrAutofixState): PrAutofixStatus {
  const { handledFailures: _failures, handledComments: _comments, ...status } = state
  return status
}

/** Serialized atomic writes also keep a slow polling read from undoing a user's disable. */
export class PrAutofixStore {
  private operations: Promise<void> = Promise.resolve()
  constructor(readonly directory = process.env.COMMANDO_PR_AUTOFIX_DIR ?? join(homedir(), '.commando', 'pr-autofix')) {}

  private async load(): Promise<PrAutofixState[]> {
    let text: string
    try { text = await readFile(join(this.directory, 'watches.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const value = JSON.parse(text) as { version: number; watches: PrAutofixState[] }
    if (value.version !== 1 || !Array.isArray(value.watches)) throw new Error('Invalid PR auto-fix store')
    for (const state of value.watches) {
      validateRepo(state.repo); validatePrNumber(state.number); validatePaneTargetId(state.targetId)
      if (typeof state.enabled !== 'boolean' || !['watching', 'fix-requested', 'capped', 'stopped'].includes(state.status) ||
        !Number.isInteger(state.rounds) || state.rounds < 0 || state.rounds > PR_AUTOFIX_MAX_ROUNDS ||
        !Array.isArray(state.handledFailures) || !state.handledFailures.every((key) => typeof key === 'string') ||
        !Array.isArray(state.handledComments) || !state.handledComments.every((key) => typeof key === 'string') ||
        (state.lastEventAt !== null && !Number.isFinite(state.lastEventAt)) ||
        (state.reason !== undefined && typeof state.reason !== 'string')) throw new Error('Invalid PR auto-fix state')
    }
    return value.watches
  }

  private async save(watches: PrAutofixState[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify({ version: 1, watches })}\n`, { mode: 0o600 })
    await rename(temporary, join(this.directory, 'watches.json'))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation)
    this.operations = next.then(() => undefined, () => undefined)
    return next
  }

  list(): Promise<PrAutofixState[]> { return this.serialize(() => this.load()) }
  async get(repo: string, number: number): Promise<PrAutofixState | null> {
    return (await this.list()).find((state) => state.repo.toLowerCase() === repo.toLowerCase() && state.number === number) ?? null
  }

  update(repo: string, number: number, change: (current: PrAutofixState | null) => PrAutofixState | null, deliver?: () => boolean): Promise<PrAutofixState | null> {
    return this.serialize(async () => {
      const watches = await this.load()
      const index = watches.findIndex((state) => state.repo.toLowerCase() === repo.toLowerCase() && state.number === number)
      const current = watches[index] ?? null
      const next = change(current)
      if (!next || next === current) return current
      if (index < 0) watches.push(next)
      else watches[index] = next
      // Reserve dedupe keys durably before dispatch, so restarting cannot resend a round.
      await this.save(watches)
      if (deliver && !deliver()) {
        if (index < 0) watches.pop()
        else watches[index] = current!
        await this.save(watches)
        return current
      }
      return next
    })
  }
}

type Target = { paneId: string; busy: boolean; connected: boolean }
export class PrAutofixWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  constructor(readonly store: PrAutofixStore, private readonly dependencies: {
    snapshot: (repo: string, number: number, targetId: string) => Promise<PrAutofixSnapshot>
    target: (targetId: string) => Target | undefined
    send: (paneId: string, prompt: string) => boolean
    log?: (error: unknown) => void
    now?: () => number
  }) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick().catch((error: unknown) => this.dependencies.log?.(error)) }, PR_AUTOFIX_INTERVAL_MS)
    this.timer.unref()
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined }
  hasTarget(targetId: string): boolean { return Boolean(this.dependencies.target(targetId)) }

  tick(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.poll().finally(() => { this.polling = undefined })
    return this.polling
  }

  private async poll(): Promise<void> {
    for (const watch of await this.store.list()) {
      if (!watch.enabled || watch.status === 'capped' || watch.status === 'stopped') continue
      try {
        const target = this.dependencies.target(watch.targetId)
        if (!target) {
          await this.store.update(watch.repo, watch.number, (current) => current?.enabled && current.targetId === watch.targetId
            ? { ...current, enabled: false, status: 'stopped', reason: 'Pane or agent no longer exists' } : current)
          continue
        }
        if (!target.connected) continue
        const snapshot = await this.dependencies.snapshot(watch.repo, watch.number, watch.targetId)
        let decision: Decision | undefined
        await this.store.update(watch.repo, watch.number, (current) => {
          if (!current || current.targetId !== watch.targetId) return current
          const live = this.dependencies.target(current.targetId)
          if (!live) return { ...current, enabled: false, status: 'stopped', reason: 'Pane or agent no longer exists' }
          decision = decidePrAutofix(snapshot, current, live.busy || !live.connected, (this.dependencies.now ?? Date.now)())
          return decision.state
        }, () => {
          if (decision?.action !== 'send') return true
          const live = this.dependencies.target(watch.targetId)
          return Boolean(live?.connected && !live.busy && this.dependencies.send(live.paneId, decision.prompt))
        })
      } catch (error) { this.dependencies.log?.(error) }
    }
  }
}
