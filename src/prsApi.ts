import type { NewStackedPr, PrStack, StackedPrResult } from '../shared/pr-stacks.js'
import type { PanePrList, PrAutofixStatus, PrList, PrScope, PrStateFilter } from '../shared/pr-types.js'
export type { PanePrList, PanePrSummary, PrList, PrScope, PrStateFilter, PrSummary, PrStatus, PrCheckState, PrCheckRun, PrChecks, PrReview } from '../shared/pr-types.js'
export type PrThreadExcerpt = { path: string | null; author: string | null; excerpt: string }
export type PrThreads = { repo: string; number: number; threads: PrThreadExcerpt[]; truncated: boolean; fetchedAt: number }
export type PrRepoOption = { nameWithOwner: string; pinned: boolean }
export type PrPreferences = {
  version: 1
  pinnedRepos: string[]
  recentRepos: string[]
  lastRepo: string | null
  lastFilter: PrStateFilter
  lastScope: PrScope
}

// Separate clients for the same auth/transport share one store. Tests and other
// credentials remain isolated without a process-wide singleton leaking data.
const storeKeys = new WeakMap<typeof fetch, Map<string, object>>()
// Attachments never change, so recent ones are kept for the page's life. The
// cap keeps a long-open cockpit from piling up images of up to 10 MB each.
const ASSET_CACHE_SIZE = 32
const assetUrls = new WeakMap<typeof fetch, Map<string, Promise<string>>>()

/**
 * data:, not blob:. The page CSP allows data: images, and an SVG opened in its
 * own tab gets an opaque origin, so any script in it can't reach the daemon.
 */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
}

export function createPrsApi(token: string, fetcher: typeof fetch = fetch) {
  let keys = storeKeys.get(fetcher)
  if (!keys) { keys = new Map(); storeKeys.set(fetcher, keys) }
  let storeKey = keys.get(token)
  if (!storeKey) { storeKey = {}; keys.set(token, storeKey) }
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`/api/prs${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const result = await response.json().catch(() => ({})) as { error?: string; code?: string; retryAt?: number }
    if (!response.ok) {
      const error = new Error(result.error ?? `PR request failed (${response.status})`)
      Object.assign(error, { code: result.code, retryAt: result.retryAt })
      throw error
    }
    return result as T
  }
  /** A GitHub attachment fetched through the daemon, which has the GitHub login, as a data: URL. */
  const asset = (src: string): Promise<string> => {
    let cache = assetUrls.get(fetcher)
    if (!cache) { cache = new Map(); assetUrls.set(fetcher, cache) }
    const cached = cache.get(src)
    if (cached) {
      // Re-insert so eviction drops the least recently used image.
      cache.delete(src)
      cache.set(src, cached)
      return cached
    }
    const url = fetcher(`/api/prs/asset?url=${encodeURIComponent(src)}`, {
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Image request failed (${response.status})`)
      return dataUrl(await response.blob())
    })
    cache.set(src, url)
    while (cache.size > ASSET_CACHE_SIZE) cache.delete(cache.keys().next().value!)
    url.catch(() => { if (cache.get(src) === url) cache.delete(src) })
    return url
  }
  return {
    storeKey,
    asset,
    autofixStatus: async (repo: string, number: number) =>
      (await request<{ status: PrAutofixStatus | null }>(`/autofix?repo=${encodeURIComponent(repo)}&number=${number}`)).status,
    setAutofix: async (repo: string, number: number, enabled: boolean, paneId: string) =>
      (await request<{ status: PrAutofixStatus | null }>('/autofix', { method: 'PUT', body: JSON.stringify({ repo, number, enabled, paneId }) })).status,
    stack: async (repo: string, number: number) =>
      (await request<{ stack: PrStack }>(`/stack?repo=${encodeURIComponent(repo)}&number=${number}`)).stack,
    linkStack: async (repo: string, numbers: number[]) =>
      (await request<{ stack: PrStack }>('/stack', { method: 'POST', body: JSON.stringify({ repo, numbers }) })).stack,
    createStackedPr: async (repo: string, parentNumber: number, input: NewStackedPr, paneId?: string) =>
      request<StackedPrResult>('/stacked-pr', { method: 'POST', body: JSON.stringify({ repo, parentNumber, ...input, ...(paneId ? { paneId } : {}) }) }),
    threadAction: async (repo: string, number: number, threadId: string, action: 'reply' | 'resolve' | 'reopen', body?: string) =>
      request<{ ok: true }>('/thread-action', { method: 'POST', body: JSON.stringify({ repo, number, threadId, action, ...(body !== undefined ? { body } : {}) }) }),
    conflicts: async (repo: string, number: number) =>
      (await request<{ conflicts: import('../shared/pr-quick-look.js').PrConflicts }>(`/conflicts?repo=${encodeURIComponent(repo)}&number=${number}`)).conflicts,
    details: async (repo: string, number: number) =>
      (await request<{ details: import('../shared/pr-quick-look.js').PrDetails }>(`/details?repo=${encodeURIComponent(repo)}&number=${number}`)).details,
    diff: async (repo: string, number: number) =>
      (await request<{ diff: import('../shared/pr-quick-look.js').PrRemoteDiff }>(`/diff?repo=${encodeURIComponent(repo)}&number=${number}`)).diff,
    renderDiff: async (path: string, patch: string, width: number) =>
      (await request<{ ansi: string }>('/diff-render', { method: 'POST', body: JSON.stringify({ path, patch, width }) })).ansi,
    merge: async (repo: string, number: number, headRefOid: string, baseRefName?: string) =>
      request<{ merged: true }>('/merge', { method: 'POST', body: JSON.stringify({ repo, number, headRefOid, ...(baseRefName ? { baseRefName } : {}) }) }),
    list: async (repo: string, state: PrStateFilter, options?: { refresh?: boolean; scope?: PrScope }) =>
      (await request<{ list: PrList }>(
        `?repo=${encodeURIComponent(repo)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(options?.scope ?? 'mine')}${options?.refresh ? '&refresh=1' : ''}`,
      )).list,
    threads: async (repo: string, number: number) =>
      (await request<{ threads: PrThreads }>(`/threads?repo=${encodeURIComponent(repo)}&number=${number}`)).threads,
    pane: async (paneId: string, options?: { refresh?: boolean; background?: boolean }) =>
      (await request<{ list: PanePrList }>(`/pane?paneId=${encodeURIComponent(paneId)}${options?.refresh ? '&refresh=1' : options?.background ? '&background=1' : ''}`)).list,
    repoForPane: async (paneId: string) =>
      (await request<{ repo: string | null }>(`/repo?paneId=${encodeURIComponent(paneId)}`)).repo,
    repos: async () => (await request<{ repos: PrRepoOption[] }>('/repos')).repos,
    prefs: async () => (await request<{ prefs: PrPreferences }>('/prefs')).prefs,
    updatePrefs: async (patch: Partial<Omit<PrPreferences, 'version' | 'recentRepos'>>) =>
      (await request<{ prefs: PrPreferences }>('/prefs', { method: 'PUT', body: JSON.stringify(patch) })).prefs,
  }
}
export type PrsApiClient = ReturnType<typeof createPrsApi>
