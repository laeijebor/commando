export type GitChangedFile = {
  path: string
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type GitPullRequest = {
  number: number
  title: string
  url: string
  isDraft: boolean
}

export type GitDiffSummary = {
  isRepo: boolean
  root?: string
  branch?: string
  pullRequest?: GitPullRequest
  /** Human-readable label of what the diff is against. */
  target?: string | null
  /** 'auto' = branch point detected by the daemon; 'ref' = user-chosen target. */
  targetMode?: 'auto' | 'ref'
  baseCommit?: string
  additions?: number
  deletions?: number
  files?: GitChangedFile[]
}

export type GitFileDiff = {
  file: string
  diff: string
}

export type GitDiffSearchMatch = {
  file: string
  line: number
  side: 'added' | 'removed'
  preview: string
  occurrences: number
}

export type GitDiffSearchFile = {
  file: string
  matches: number
}

export type GitDiffSearchResult = {
  query: string
  matches: GitDiffSearchMatch[]
  files: GitDiffSearchFile[]
  totalMatches: number
  matchingFiles: number
  truncated: boolean
}

export type GitBranches = {
  isRepo: boolean
  current?: string
  branches?: string[]
}

export type DiffEngine = 'difftastic' | 'delta'
export type DiffDisplay = 'side-by-side' | 'inline'

export type GitFileDiffOptions = {
  target?: string
  head?: string
  width?: number
  engine?: DiffEngine
  display?: DiffDisplay
}

export interface GitDiffApiClient {
  summary(paneId: string, target?: string, head?: string): Promise<GitDiffSummary>
  fileDiff(paneId: string, file: string, options?: GitFileDiffOptions): Promise<GitFileDiff>
  search(paneId: string, query: string, target?: string, head?: string): Promise<GitDiffSearchResult>
  branches(paneId: string): Promise<GitBranches>
}

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Git diff request failed (${status})`
  return new Error(message)
}

export function createGitDiffApi(token: string, fetcher: typeof fetch = fetch): GitDiffApiClient {
  const request = async <T>(path: string, params: Record<string, string | undefined>): Promise<T> => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, value)
    }
    const response = await fetcher(`/api/git/${path}?${search.toString()}`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
    return body as T
  }

  return {
    summary: (paneId, target, head) => request<GitDiffSummary>('summary', { paneId, target, head }),
    fileDiff: (paneId, file, options = {}) =>
      request<GitFileDiff>('file-diff', {
        paneId,
        file,
        target: options.target,
        head: options.head,
        width: options.width === undefined ? undefined : String(options.width),
        engine: options.engine,
        display: options.display,
      }),
    search: (paneId, query, target, head) => request<GitDiffSearchResult>('search', { paneId, query, target, head }),
    branches: (paneId) => request<GitBranches>('branches', { paneId }),
  }
}
