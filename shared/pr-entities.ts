import type { PanePrList, PanePrSummary, PrList, PrSummary } from './pr-types.js'

type Entity = { pr: PanePrSummary; at: number; order: number }

/** One status record per GitHub PR; query results only determine membership. */
export class PrEntities {
  private readonly entities = new Map<string, Entity>()
  private readOrder = 0
  private version = 0
  private readonly paneViews = new WeakMap<PanePrList, { version: number; list: PanePrList }>()
  private readonly repoViews = new WeakMap<PrList, { version: number; list: PrList }>()
  private readonly repoPrViews = new WeakMap<PrSummary, { preview: PrSummary; pr: PrSummary }>()
  private readonly invalidated = new Map<string, number>()

  beginRead(): number { return ++this.readOrder }

  invalidate(repo: string): void {
    this.invalidated.set(repo.toLowerCase(), this.beginRead())
  }

  markMerged(repo: string, number: number, at: number): void {
    const current = this.entities.get(this.key(repo, number))
    if (!current) return
    this.invalidate(repo)
    // A daemon clock ahead of the browser must not defeat a confirmed write.
    at = Math.max(at, current.at)
    this.ingest({ targetId: '', totalCount: 1, truncated: false, fetchedAt: at,
      pullRequests: [{ ...current.pr, state: 'merged', statusFetchedAt: at }] }, this.beginRead())
  }

  /** Daemon query caches are bounded; do not retain their evicted PRs forever. */
  retain(lists: readonly (PanePrList | PrList)[]): void {
    const keys = new Set(lists.flatMap((list) => list.pullRequests.map((pr) =>
      this.key('repo' in list ? list.repo : (pr as PanePrSummary).repo, pr.number))))
    for (const key of this.entities.keys()) {
      if (keys.has(key)) continue
      this.entities.delete(key)
      this.version += 1
    }
  }

  private key(repo: string, number: number): string { return `${repo.toLowerCase()}#${number}` }

  ingest(list: PanePrList | PrList, order: number): void {
    for (const source of list.pullRequests) {
      const pr: PanePrSummary = 'repo' in list
        ? { ...source, repo: list.repo, preview: source as PrList['pullRequests'][number] }
        : source as PanePrSummary
      const key = this.key(pr.repo, pr.number)
      if (order < (this.invalidated.get(pr.repo.toLowerCase()) ?? 0)) continue
      const at = pr.statusFetchedAt ?? list.fetchedAt
      const current = this.entities.get(key)
      if (current && (current.at > at || (current.at === at && current.order > order))) continue
      const { repo, preview } = pr
      const status = {
        number: pr.number, title: pr.title, url: pr.url, state: pr.state, isDraft: pr.isDraft,
        createdAt: pr.createdAt, updatedAt: pr.updatedAt, additions: pr.additions, deletions: pr.deletions,
        checks: pr.checks, conflicting: pr.conflicting, unresolvedThreads: pr.unresolvedThreads,
        unansweredThreads: pr.unansweredThreads, threadsTruncated: pr.threadsTruncated, reviewDecision: pr.reviewDecision,
        stack: pr.stack === undefined ? current?.pr.stack : pr.stack,
      }
      // Older daemons can return a pane summary without a full preview. Keep
      // known detail fields, but overlay every shared status field atomically.
      const full = preview ?? current?.pr.preview
      this.entities.set(key, { at, order, pr: {
        repo, ...status, statusFetchedAt: at,
        ...(full ? { preview: { ...full,
          ...(!preview ? { mergeable: status.conflicting ? 'CONFLICTING' : 'UNKNOWN', mergeStateStatus: 'UNKNOWN' } : {}),
          ...status, statusFetchedAt: at } } : {}),
      } })
      this.version += 1
    }
  }

  pane(list: PanePrList): PanePrList {
    const cached = this.paneViews.get(list)
    if (cached?.version === this.version) return cached.list
    let changed = false
    const pullRequests = list.pullRequests.map((pr) => {
      const next = this.entities.get(this.key(pr.repo, pr.number))?.pr ?? pr
      if (next !== pr) changed = true
      return next
    })
    const result = cached && sameItems(cached.list.pullRequests, pullRequests) ? cached.list
      : changed ? { ...list, pullRequests } : list
    this.paneViews.set(list, { version: this.version, list: result })
    return result
  }

  repo(list: PrList): PrList {
    const cached = this.repoViews.get(list)
    if (cached?.version === this.version) return cached.list
    let changed = false
    const pullRequests = list.pullRequests.flatMap((pr) => {
      const entity = this.entities.get(this.key(list.repo, pr.number))?.pr
      if (!entity?.preview) return [pr]
      // The search query also detects team review requests, which pane reads
      // cannot infer. Keep these membership flags specific to the repo query.
      let next = entity.preview
      if (next.viewerIsAuthor !== pr.viewerIsAuthor || next.viewerReviewRequested !== pr.viewerReviewRequested) {
        const view = this.repoPrViews.get(pr)
        next = view?.preview === entity.preview ? view.pr : { ...entity.preview,
          viewerIsAuthor: pr.viewerIsAuthor, viewerReviewRequested: pr.viewerReviewRequested }
        this.repoPrViews.set(pr, { preview: entity.preview, pr: next })
      }
      if (next !== pr) changed = true
      if ((list.filter === 'open' && next.state !== 'open') || (list.filter === 'closed' && next.state === 'open')) {
        changed = true
        return []
      }
      return [next]
    })
    const result = cached && sameItems(cached.list.pullRequests, pullRequests) ? cached.list
      : changed ? { ...list, pullRequests,
      totalCount: Math.max(0, list.totalCount - (list.pullRequests.length - pullRequests.length)) } : list
    this.repoViews.set(list, { version: this.version, list: result })
    return result
  }
}

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}
