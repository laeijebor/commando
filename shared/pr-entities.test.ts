import { describe, expect, it } from 'vitest'
import { PrEntities } from './pr-entities.js'
import type { PanePrList, PrList, PrSummary } from './pr-types.js'

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return { number: 12, title: 'Widgets', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
    author: 'leo', bodyExcerpt: 'Description', additions: 10, deletions: 2, changedFiles: 1, commitCount: 1,
    unresolvedThreads: 1, unansweredThreads: 1, threadsTruncated: false, reviewDecision: null, reviews: [], requestedReviewers: [],
    conflicting: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', checks: null, createdAt: '', updatedAt: '',
    headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    viewerIsAuthor: true, viewerReviewRequested: false, commandoMarker: null, ...overrides }
}
function repo(summary = pr(), fetchedAt = 1, name = 'acme/widgets'): PrList {
  return { repo: name, filter: 'open', viewer: 'leo', totalCount: 1, truncated: false, mineTruncated: false, fetchedAt, pullRequests: [summary] }
}
function pane(summary = pr(), fetchedAt = 1, name = 'acme/widgets'): PanePrList {
  return { targetId: 'target', totalCount: 1, truncated: false, fetchedAt,
    pullRequests: [{ ...summary, repo: name, preview: summary }] }
}

describe('normalized GitHub PR entities', () => {
  it('shares stack membership across pane and repo views, preserving unknown legacy data and clearing explicit removal', () => {
    const store = new PrEntities()
    const sidebar = pane()
    store.ingest(sidebar, store.beginRead())
    const membership = { number: 7, size: 2, position: 2, baseRefName: 'main' }
    const hud = repo(pr({ stack: membership }), 2)
    store.ingest(hud, store.beginRead())
    expect(store.pane(sidebar).pullRequests[0].stack).toEqual(membership)
    store.ingest(pane(pr(), 3), store.beginRead())
    expect(store.repo(hud).pullRequests[0].stack).toEqual(membership)
    store.ingest(pane(pr({ stack: null }), 4), store.beginRead())
    expect(store.repo(hud).pullRequests[0].stack).toBeNull()
    expect(store.pane(sidebar).pullRequests[0].stack).toBeNull()
  })
  it('shares status between case-insensitive repo and pane views, including full previews', () => {
    const store = new PrEntities()
    const sidebar = pane()
    store.ingest(sidebar, store.beginRead())
    const hud = repo(pr({ conflicting: true, mergeable: 'CONFLICTING', unansweredThreads: 0, unresolvedThreads: 2 }), 2, 'ACME/Widgets')
    store.ingest(hud, store.beginRead())
    expect(store.pane(sidebar).pullRequests[0]).toMatchObject({ conflicting: true, unansweredThreads: 0, unresolvedThreads: 2 })
    expect(store.pane(sidebar).pullRequests[0].preview).toEqual(store.repo(hud).pullRequests[0])
    expect(store.pane(sidebar)).toBe(store.pane(sidebar))
    expect(store.repo(hud)).toBe(store.repo(hud))
    const next = pane(pr({ additions: 20, unresolvedThreads: 0, unansweredThreads: 0 }), 3)
    store.ingest(next, store.beginRead())
    expect(store.repo(hud).pullRequests[0]).toMatchObject({ conflicting: false, additions: 20, unresolvedThreads: 0 })
  })

  it('ignores a late older read even when timestamps tie', () => {
    const store = new PrEntities()
    const oldOrder = store.beginRead()
    const latest = repo(pr({ title: 'Latest' }))
    store.ingest(latest, store.beginRead())
    const old = pane(pr({ title: 'Old' }))
    store.ingest(old, oldOrder)
    expect(store.pane(old).pullRequests[0].title).toBe('Latest')
    expect(store.repo(latest).pullRequests[0].title).toBe('Latest')
  })

  it('rejects later-arriving cached status and transports entity freshness separately from membership', () => {
    const store = new PrEntities()
    store.ingest(repo(pr({ title: 'Latest' }), 20), store.beginRead())
    const cached = pane(pr({ title: 'Old' }), 10)
    store.ingest(cached, store.beginRead())
    const result = store.pane(cached)
    expect(result.fetchedAt).toBe(10)
    expect(result.pullRequests[0]).toMatchObject({ title: 'Latest', statusFetchedAt: 20 })
    const client = new PrEntities()
    client.ingest(result, client.beginRead())
    client.ingest(repo(pr({ title: 'Also old' }), 15), client.beginRead())
    expect(client.pane(result).pullRequests[0].title).toBe('Latest')
  })

  it('retains repo-specific membership and team review flags, filtering merged PRs from open views', () => {
    const store = new PrEntities()
    const mine = repo(pr({ viewerIsAuthor: false, viewerReviewRequested: true }))
    store.ingest(mine, store.beginRead())
    const closed = { ...repo(pr({ state: 'closed' }), 1), filter: 'closed' as const }
    const latest = pane(pr(), 2)
    store.ingest(latest, store.beginRead())
    expect(store.repo(mine).pullRequests[0].viewerReviewRequested).toBe(true)
    expect(store.repo(closed).pullRequests).toEqual([])
    store.ingest(pane(pr({ number: 99 }), 3), store.beginRead())
    expect(store.repo(mine).pullRequests.map((item) => item.number)).toEqual([12])
    store.markMerged('ACME/Widgets', 12, 4)
    expect(store.repo(mine)).toMatchObject({ pullRequests: [], totalCount: 0 })
    expect(store.pane(latest).pullRequests[0]).toMatchObject({ state: 'merged', preview: { state: 'merged' } })
    store.ingest(pane(pr(), 3), store.beginRead())
    expect(store.repo(mine).pullRequests).toEqual([])
    store.ingest(pane(pr(), 5), store.beginRead())
    expect(store.repo(mine).pullRequests).toHaveLength(1)
  })

  it('preserves details for legacy pane summaries without trusting old mergeability', () => {
    const store = new PrEntities()
    const hud = repo()
    store.ingest(hud, store.beginRead())
    const legacy = pane(pr({ conflicting: true, unresolvedThreads: 0 }), 2)
    delete legacy.pullRequests[0].preview
    store.ingest(legacy, store.beginRead())
    expect(store.repo(hud).pullRequests[0]).toMatchObject({ conflicting: true, unresolvedThreads: 0,
      bodyExcerpt: 'Description', headRefName: 'feature', mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' })
  })

  it('isolates repositories with matching PR numbers and prevents pre-write reads from repopulating entities', () => {
    const store = new PrEntities()
    const hud = repo()
    store.ingest(hud, store.beginRead())
    const oldRead = store.beginRead()
    store.invalidate('ACME/Widgets')
    store.ingest(pane(pr({ conflicting: true }), 50), oldRead)
    store.ingest(repo(pr({ title: 'Other repo' }), 50, 'other/widgets'), store.beginRead())
    expect(store.repo(hud).pullRequests[0]).toMatchObject({ title: 'Widgets', conflicting: false })
  })

  it('keeps unrelated snapshots stable and evicts entities only when their query memberships are gone', () => {
    const store = new PrEntities()
    const hud = repo(pr({ viewerReviewRequested: true }))
    const sidebar = pane()
    store.ingest(hud, store.beginRead())
    store.ingest(sidebar, store.beginRead())
    const repoView = store.repo(hud)
    const paneView = store.pane(sidebar)
    store.ingest(repo(pr({ title: 'Other repo' }), 2, 'other/widgets'), store.beginRead())
    expect(store.repo(hud)).toBe(repoView)
    expect(store.pane(sidebar)).toBe(paneView)
    store.retain([hud, sidebar])
    expect(store.repo(hud)).toBe(repoView)
    store.retain([])
    expect(store.pane(sidebar)).toBe(sidebar)
  })

  it('honors confirmed merges despite clock skew and ignores even later-dated pre-write reads', () => {
    const store = new PrEntities()
    const sidebar = pane(pr(), 20)
    store.ingest(sidebar, store.beginRead())
    const oldRead = store.beginRead()
    store.markMerged('acme/widgets', 12, 10)
    store.ingest(repo(pr(), 30), oldRead)
    expect(store.pane(sidebar).pullRequests[0]).toMatchObject({ state: 'merged', statusFetchedAt: 20 })
  })
})
