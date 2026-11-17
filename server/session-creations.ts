import { randomUUID } from 'node:crypto'
import type {
  CreateTmuxSessionRequest,
  SessionCreation,
  SessionCreationProgress,
  StartSessionCreationRequest,
  TmuxCreateResponse,
} from '../shared/tmux-create.js'

type CreateSession = (input: CreateTmuxSessionRequest, onProgress: SessionCreationProgress) => Promise<TmuxCreateResponse>

/**
 * The client that started a creation dismisses it once it has finished it. This is only the
 * fallback, long enough for a phone that was asleep through the checkout to reconnect.
 */
const DONE_KEPT_MS = 60 * 60_000
const FAILED_KEPT = 20

type Job = { creation: SessionCreation; request: CreateTmuxSessionRequest }

/**
 * Sessions being created in the background. A worktree checkout can take minutes, so instead of
 * holding the request open, `start` answers once the slow part begins and clients follow the
 * creation through `onChange` (broadcast over the websocket).
 */
export class SessionCreations {
  private readonly jobs = new Map<string, Job>()

  constructor(
    private readonly create: CreateSession,
    private readonly onChange: (creations: SessionCreation[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  list(): SessionCreation[] {
    return [...this.jobs.values()].map((job) => job.creation)
  }

  /**
   * Starts creating a session. Resolves with the creation when it is done, or as soon as it starts
   * fetching or checking out, after which it carries on in the background. Rejects, leaving nothing
   * listed, when it fails before then (a bad name, a branch checked out elsewhere), so the form that
   * asked can show the error and stay open.
   */
  start(input: StartSessionCreationRequest): Promise<SessionCreation> {
    const { groupId, ...request } = input
    const creation: SessionCreation = {
      id: randomUUID(),
      name: typeof request.name === 'string' ? request.name : '',
      cwd: typeof request.cwd === 'string' ? request.cwd : '',
      ...(typeof request.worktree?.branch === 'string' && request.worktree.branch ? { branch: request.worktree.branch } : {}),
      ...(typeof groupId === 'string' && groupId ? { groupId } : {}),
      stage: 'preparing',
      startedAt: this.now(),
    }
    return this.run({ creation, request }, false)
  }

  /** Runs a failed creation again with the same request. */
  retry(id: string): SessionCreation | undefined {
    const job = this.jobs.get(id)
    if (job?.creation.stage !== 'failed') return undefined
    const { error: _error, percent: _percent, ...rest } = job.creation
    job.creation = { ...rest, stage: 'preparing', startedAt: this.now() }
    void this.run(job, true)
    return job.creation
  }

  /** Forgets a finished or failed creation; one still running cannot be dismissed. */
  dismiss(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || (job.creation.stage !== 'done' && job.creation.stage !== 'failed')) return false
    this.jobs.delete(id)
    this.changed()
    return true
  }

  private run(job: Job, listed: boolean): Promise<SessionCreation> {
    const { id } = job.creation
    return new Promise((resolve, reject) => {
      const update = (patch: Partial<SessionCreation>) => {
        const { percent: _percent, ...rest } = job.creation
        job.creation = { ...rest, ...patch }
        if (listed) this.changed()
      }
      const background = () => {
        if (listed) return
        listed = true
        this.jobs.set(id, job)
        this.changed()
        resolve(job.creation)
      }
      this.create(job.request, (stage, percent) => {
        update({ stage, ...(percent === undefined ? {} : { percent }) })
        if (stage === 'fetching' || stage === 'checking-out') background()
      }).then((result) => {
        update({ stage: 'done', result })
        if (!listed) {
          resolve(job.creation)
          return
        }
        setTimeout(() => {
          if (this.jobs.get(id) === job && job.creation.stage === 'done') {
            this.jobs.delete(id)
            this.changed()
          }
        }, DONE_KEPT_MS).unref()
      }, (error: unknown) => {
        if (!listed) {
          reject(error)
          return
        }
        update({ stage: 'failed', error: error instanceof Error ? error.message : 'Unable to create the session' })
        this.dropOldFailures()
      })
    })
  }

  private dropOldFailures(): void {
    const failed = [...this.jobs.values()].filter((job) => job.creation.stage === 'failed')
    const stale = failed.slice(0, Math.max(0, failed.length - FAILED_KEPT))
    for (const job of stale) this.jobs.delete(job.creation.id)
    if (stale.length) this.changed()
  }

  private changed(): void {
    this.onChange(this.list())
  }
}
