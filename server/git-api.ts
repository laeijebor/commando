import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  GitDiffError,
  GitDiffInspector,
  validateDiffDisplay,
  validateDiffEngine,
  validateDiffWidth,
} from './git-diff.js'
import { validateTmuxPaneId } from './tmux-pane-actions.js'
import type { GitRepoInfo } from '../shared/tmux-create.js'

const API_ROOT = '/api/git'

const ERROR_STATUS: Record<GitDiffError['kind'], number> = {
  'bad-target': 400,
  'bad-file': 400,
  'bad-param': 400,
  'tool-missing': 501,
  exec: 502,
}

type GitApiDependencies = {
  inspector?: GitDiffInspector
  panePath: (paneId: string) => string | undefined
  panePullRequestEvidence?: (paneId: string) => Promise<string | undefined>
  /** Describes the repository containing an absolute directory (worktree-aware). */
  repoInfo?: (directory: string) => Promise<GitRepoInfo>
}

const MAX_PATH_BYTES = 4_096
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

export class GitDiffApi {
  private readonly inspector: GitDiffInspector

  constructor(private readonly dependencies: GitApiDependencies) {
    this.inspector = dependencies.inspector ?? new GitDiffInspector()
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(`${API_ROOT}/`)) return false

    try {
      const routes = [`${API_ROOT}/summary`, `${API_ROOT}/file-diff`, `${API_ROOT}/search`, `${API_ROOT}/branches`, `${API_ROOT}/repo`]
      if (!routes.includes(url.pathname)) {
        throw new HttpError(404, 'Not found')
      }
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed')

      if (url.pathname === `${API_ROOT}/repo`) {
        if (!this.dependencies.repoInfo) throw new HttpError(501, 'Repository probe is not available')
        writeJson(response, 200, await this.dependencies.repoInfo(this.resolveDirectory(url)))
        return true
      }

      const { paneId, path: panePath } = this.resolvePane(url)
      const target = url.searchParams.get('target') ?? undefined
      const head = url.searchParams.get('head') ?? undefined

      if (url.pathname === `${API_ROOT}/summary`) {
        let summary = await this.inspector.summary(panePath, target, head)
        if (
          target === undefined &&
          !summary.pullRequest &&
          summary.root &&
          this.dependencies.panePullRequestEvidence
        ) {
          const evidence = await this.dependencies.panePullRequestEvidence(paneId).catch(() => undefined)
          const pullRequest = evidence
            ? await this.inspector.pullRequestFromEvidence(summary.root, evidence)
            : undefined
          if (pullRequest) summary = { ...summary, pullRequest }
        }
        writeJson(response, 200, summary)
        return true
      }

      if (url.pathname === `${API_ROOT}/branches`) {
        writeJson(response, 200, await this.inspector.branches(panePath))
        return true
      }

      if (url.pathname === `${API_ROOT}/search`) {
        writeJson(response, 200, await this.inspector.search(
          panePath,
          url.searchParams.get('query'),
          target,
          head,
        ))
        return true
      }

      const file = url.searchParams.get('file')
      if (!file) throw new HttpError(400, 'file query parameter is required')
      const width = validateDiffWidth(url.searchParams.get('width') ?? undefined)
      const engine = validateDiffEngine(url.searchParams.get('engine') ?? undefined)
      const display = validateDiffDisplay(url.searchParams.get('display') ?? undefined)
      const diff = await this.inspector.fileDiff(panePath, file, target, width, engine, display, head)
      writeJson(response, 200, { file, diff })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 405) response.setHeader('Allow', 'GET')
        writeJson(response, error.status, { error: error.message })
        return true
      }
      if (error instanceof GitDiffError) {
        writeJson(response, ERROR_STATUS[error.kind], { error: error.message })
        return true
      }
      writeJson(response, 502, {
        error: error instanceof Error ? error.message : 'Git diff request failed',
      })
      return true
    }
  }

  private resolveDirectory(url: URL): string {
    const directory = url.searchParams.get('path') ?? ''
    if (
      !directory.startsWith('/') ||
      Buffer.byteLength(directory, 'utf8') > MAX_PATH_BYTES ||
      CONTROL_CHARACTER.test(directory)
    ) {
      throw new HttpError(400, 'path must be an absolute directory')
    }
    return directory
  }

  private resolvePane(url: URL): { paneId: string; path: string } {
    let paneId: string
    try {
      paneId = validateTmuxPaneId(url.searchParams.get('paneId'))
    } catch {
      throw new HttpError(400, 'Invalid tmux pane id')
    }
    const path = this.dependencies.panePath(paneId)
    if (!path) throw new HttpError(404, 'Tmux pane does not exist')
    return { paneId, path }
  }
}
