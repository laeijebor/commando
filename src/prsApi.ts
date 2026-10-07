import type { NewStackedPr, PrStack, StackedPrResult } from '../shared/pr-stacks'
import type { PanePrList, PrList, PrScope, PrStateFilter } from '../shared/pr-types'
export type { PanePrList, PanePrSummary, PrList, PrScope, PrStateFilter, PrSummary, PrStatus, PrCheckState, PrCheckRun, PrChecks, PrReview } from '../shared/pr-types'
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
  return {
    storeKey,
    stack: async (repo: string, number: number) =>
      (await request<{ stack: PrStack }>(`/stack?repo=${encodeURIComponent(repo)}&number=${number}`)).stack,
    linkStack: async (repo: string, numbers: number[]) =>
      (await request<{ stack: PrStack }>('/stack', { method: 'POST', body: JSON.stringify({ repo, numbers }) })).stack,
    createStackedPr: async (repo: string, parentNumber: number, input: NewStackedPr, paneId?: string) =>
      request<StackedPrResult>('/stacked-pr', { method: 'POST', body: JSON.stringify({ repo, parentNumber, ...input, ...(paneId ? { paneId } : {}) }) }),
    threadAction: async (repo: string, number: number, threadId: string, action: 'reply' | 'resolve' | 'reopen', body?: string) =>
      request<{ ok: true }>('/thread-action', { method: 'POST', body: JSON.stringify({ repo, number, threadId, action, ...(body !== undefined ? { body } : {}) }) }),
    conflicts: async (repo: string, number: number) =>
      (await request<{ conflicts: import('../shared/pr-quick-look').PrConflicts }>(`/conflicts?repo=${encodeURIComponent(repo)}&number=${number}`)).conflicts,
    details: async (repo: string, number: number) =>
      (await request<{ details: import('../shared/pr-quick-look').PrDetails }>(`/details?repo=${encodeURIComponent(repo)}&number=${number}`)).details,
    diff: async (repo: string, number: number) =>
      (await request<{ diff: import('../shared/pr-quick-look').PrRemoteDiff }>(`/diff?repo=${encodeURIComponent(repo)}&number=${number}`)).diff,
    merge: async (repo: string, number: number, headRefOid: string, baseRefName?: string) =>
      request<{ merged: true }>('/merge', { method: 'POST', body: JSON.stringify({ repo, number, headRefOid, ...(baseRefName ? { baseRefName } : {}) }) }),
    list: async (repo: string, state: PrStateFilter, options?: { refresh?: boolean; scope?: PrScope }) =>
      (await request<{ list: PrList }>(
        `?repo=${encodeURIComponent(repo)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(options?.scope ?? 'mine')}${options?.refresh ? '&refresh=1' : ''}`,
      )).list,
    threads: async (repo: string, number: number) =>
      (await request<{ threads: PrThreads }>(`/threads?repo=${encodeURIComponent(repo)}&number=${number}`)).threads,
    pane: async (paneId: string, options?: { refresh?: boolean }) =>
      (await request<{ list: PanePrList }>(`/pane?paneId=${encodeURIComponent(paneId)}${options?.refresh ? '&refresh=1' : ''}`)).list,
    repoForPane: async (paneId: string) =>
      (await request<{ repo: string | null }>(`/repo?paneId=${encodeURIComponent(paneId)}`)).repo,
    repos: async () => (await request<{ repos: PrRepoOption[] }>('/repos')).repos,
    prefs: async () => (await request<{ prefs: PrPreferences }>('/prefs')).prefs,
    updatePrefs: async (patch: Partial<Omit<PrPreferences, 'version' | 'recentRepos'>>) =>
      (await request<{ prefs: PrPreferences }>('/prefs', { method: 'PUT', body: JSON.stringify(patch) })).prefs,
  }
}
export type PrsApiClient = ReturnType<typeof createPrsApi>
