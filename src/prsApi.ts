export type PrStateFilter = 'open' | 'closed' | 'all'
export type PrScope = 'mine' | 'everyone'
export type PrCheckState = 'pass' | 'fail' | 'pending'
export type PrCheckRun = { name: string; state: PrCheckState }
export type PrChecks = { state: PrCheckState; runs: PrCheckRun[]; failed: number; pending: number; total: number; truncated: boolean } | null
export type PrSummary = {
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  author: string | null
  additions: number
  deletions: number
  changedFiles: number
  unresolvedThreads: number
  threadsTruncated: boolean
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  conflicting: boolean
  checks: PrChecks
  updatedAt: string
  headRefName: string
  viewerIsAuthor: boolean
  viewerReviewRequested: boolean
}
export type PrList = {
  repo: string
  filter: PrStateFilter
  viewer: string
  totalCount: number
  pullRequests: PrSummary[]
  truncated: boolean
  mineTruncated: boolean
  fetchedAt: number
}
export type PrRepoOption = { nameWithOwner: string; pinned: boolean }
export type PrPreferences = {
  version: 1
  pinnedRepos: string[]
  lastRepo: string | null
  lastFilter: PrStateFilter
  lastScope: PrScope
}

export function createPrsApi(token: string, fetcher: typeof fetch = fetch) {
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
    const result = await response.json().catch(() => ({})) as { error?: string; code?: string }
    if (!response.ok) {
      const error = new Error(result.error ?? `PR request failed (${response.status})`)
      ;(error as Error & { code?: string }).code = result.code
      throw error
    }
    return result as T
  }
  return {
    list: async (repo: string, state: PrStateFilter) =>
      (await request<{ list: PrList }>(`?repo=${encodeURIComponent(repo)}&state=${encodeURIComponent(state)}`)).list,
    repos: async () => (await request<{ repos: PrRepoOption[] }>('/repos')).repos,
    prefs: async () => (await request<{ prefs: PrPreferences }>('/prefs')).prefs,
    updatePrefs: async (patch: Partial<Omit<PrPreferences, 'version'>>) =>
      (await request<{ prefs: PrPreferences }>('/prefs', { method: 'PUT', body: JSON.stringify(patch) })).prefs,
  }
}
