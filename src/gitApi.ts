export type GitChangedFile = {
  path: string
  status: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

export type GitDiffSummary = {
  isRepo: boolean
  root?: string
  branch?: string
  target?: string | null
  additions?: number
  deletions?: number
  files?: GitChangedFile[]
}

export type GitFileDiff = {
  file: string
  diff: string
}

export type GitBranches = {
  isRepo: boolean
  current?: string
  branches?: string[]
}

export interface GitDiffApiClient {
  summary(paneId: string, target?: string): Promise<GitDiffSummary>
  fileDiff(paneId: string, file: string, target?: string, width?: number): Promise<GitFileDiff>
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
    summary: (paneId, target) => request<GitDiffSummary>('summary', { paneId, target }),
    fileDiff: (paneId, file, target, width) =>
      request<GitFileDiff>('file-diff', {
        paneId,
        file,
        target,
        width: width === undefined ? undefined : String(width),
      }),
    branches: (paneId) => request<GitBranches>('branches', { paneId }),
  }
}
