import type { PaneScreenshotFile, PaneScreenshotFolder } from '@commando/protocol'
import type {
  CreateTmuxPaneRequest,
  CreateTmuxSessionRequest,
  CreateTmuxWindowRequest,
  GitRepoInfo,
  TmuxCreateResponse,
} from '@commando/tmux-create'
import { TMUX_CREATE_ROUTES } from '@commando/tmux-create'

import type { PrDetail } from '../pane/prs'
import { authHeaders, daemonFetch, DaemonHttpError } from '../hosts/api'
import type { Host } from '../hosts/types'

/**
 * The owner-authenticated HTTP surfaces the Info sheet and the create flows
 * use. Shapes are copied from the daemon's own clients (`src/gitApi.ts`,
 * `src/prsApi.ts`, `src/paneScreenshotsApi.ts`) but trimmed to the fields the
 * phone renders, so a richer daemon response never breaks the app.
 */

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
  pullRequest?: { number: number; title: string; url: string; isDraft: boolean }
  target?: string | null
  targetMode?: 'auto' | 'ref'
  baseCommit?: string
  additions?: number
  deletions?: number
  files?: GitChangedFile[]
}

export type GitFileDiff = { file: string; diff: string }

export type PanePrSummary = {
  repo: string
  number: number
  title: string
  url: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  createdAt: string
  updatedAt: string
}

export type PanePrList = {
  targetId: string
  totalCount: number
  pullRequests: PanePrSummary[]
  truncated: boolean
  fetchedAt: number
}

export type PaneScreenshotListing = PaneScreenshotFolder & { files: PaneScreenshotFile[] }

/** The fields of `GET /api/prs` the Info sheet joins onto a pane's PRs. */
export type PrListEntry = PrDetail & { title: string; url: string }

export type PrRepoList = { repo: string; pullRequests: PrListEntry[] }

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed: unknown = await response.json()
    const record = (parsed ?? {}) as { error?: unknown; message?: unknown }
    if (typeof record.error === 'string' && record.error) return record.error
    if (typeof record.message === 'string' && record.message) return record.message
  } catch {
    // Fall through: the daemon answered with something that is not JSON.
  }
  return fallback
}

async function json<T>(host: Host, path: string, fallback: string, timeoutMs?: number): Promise<T> {
  const response = await daemonFetch(host, path, timeoutMs === undefined ? {} : { timeoutMs })
  if (!response.ok) {
    throw new DaemonHttpError(response.status, await errorMessage(response, `${fallback} (${response.status})`))
  }
  return await response.json() as T
}

function query(params: Record<string, string | undefined>): string {
  const search = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  return search.length ? `?${search.join('&')}` : ''
}

/** `GET /api/git/summary?paneId=…` — the diff the pane's checkout has against its target. */
export function fetchGitSummary(host: Host, paneId: string): Promise<GitDiffSummary> {
  return json<GitDiffSummary>(host, `/api/git/summary${query({ paneId })}`, 'Git summary failed', 15_000)
}

/** `GET /api/git/file-diff?paneId=…&file=…` — plain text, whatever engine the daemon picked. */
export function fetchFileDiff(host: Host, paneId: string, file: string): Promise<GitFileDiff> {
  return json<GitFileDiff>(
    host,
    `/api/git/file-diff${query({ paneId, file, display: 'inline', width: '120' })}`,
    'File diff failed',
    20_000,
  )
}

/** `GET /api/git/repo?path=…` — whether a directory is a checkout, and which one. */
export function fetchRepoInfo(host: Host, directory: string): Promise<GitRepoInfo> {
  return json<GitRepoInfo>(host, `/api/git/repo${query({ path: directory })}`, 'Repository probe failed')
}

/** `GET /api/prs/pane?paneId=…` — pull requests linked to the pane's target. */
export async function fetchPanePrs(host: Host, paneId: string): Promise<PanePrList> {
  const body = await json<{ list: PanePrList }>(host, `/api/prs/pane${query({ paneId })}`, 'PR lookup failed', 20_000)
  return body.list
}

/**
 * `GET /api/prs?repo=…&state=open` — the fuller list, asked for only so the
 * checks, review decision and unresolved threads can be shown for a PR the
 * pane is already linked to.
 */
export async function fetchRepoPrs(host: Host, repo: string): Promise<PrRepoList> {
  const body = await json<{ list: PrRepoList }>(
    host,
    `/api/prs${query({ repo, state: 'open' })}`,
    'PR list failed',
    20_000,
  )
  return body.list
}

/** `GET /api/screenshots/:folderId` — every image in a registered folder. */
export async function fetchScreenshotFolder(host: Host, folderId: string): Promise<PaneScreenshotListing> {
  const body = await json<{ folder: PaneScreenshotListing }>(
    host,
    `/api/screenshots/${encodeURIComponent(folderId)}`,
    'Screenshot listing failed',
  )
  return body.folder
}

/**
 * Screenshot images are owner-authenticated like everything else, so a token
 * host has to send the bearer header with the image request. RN's `Image`
 * takes `headers` on its source for exactly this; cookie hosts send nothing
 * and rely on the native cookie jar.
 */
export function screenshotImageSource(
  host: Host,
  folderId: string,
  file: PaneScreenshotFile,
): { uri: string; headers?: Record<string, string> } {
  const uri = `${host.baseUrl}/screenshots/${encodeURIComponent(folderId)}/${encodeURIComponent(file.name)}?v=${encodeURIComponent(String(file.modifiedAt))}`
  const headers = authHeaders(host)
  return Object.keys(headers).length ? { uri, headers } : { uri }
}

async function post<T>(host: Host, path: string, body: unknown, fallback: string): Promise<T> {
  const response = await daemonFetch(host, path, { method: 'POST', body, timeoutMs: 20_000 })
  if (!response.ok) {
    throw new DaemonHttpError(response.status, await errorMessage(response, `${fallback} (${response.status})`))
  }
  return await response.json().catch(() => ({})) as T
}

/** `POST /api/pane-management/panes/:paneId/run` — runs a command in the pane's directory. */
export function runInPane(host: Host, paneId: string, command: string): Promise<{ ok?: boolean }> {
  return post(
    host,
    `/api/pane-management/panes/${encodeURIComponent(paneId)}/run`,
    { command },
    'Launching the agent failed',
  )
}

export function createTmuxSession(host: Host, input: CreateTmuxSessionRequest): Promise<TmuxCreateResponse> {
  return post(host, TMUX_CREATE_ROUTES.session, input, 'Creating the session failed')
}

export function createTmuxWindow(host: Host, input: CreateTmuxWindowRequest): Promise<TmuxCreateResponse> {
  return post(host, TMUX_CREATE_ROUTES.window, input, 'Creating the window failed')
}

export function createTmuxPane(host: Host, input: CreateTmuxPaneRequest): Promise<TmuxCreateResponse> {
  return post(host, TMUX_CREATE_ROUTES.pane, input, 'Splitting the pane failed')
}
