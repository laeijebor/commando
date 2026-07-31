import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { GitDiffApi } from './git-api.js'
import { GitCommandFailure, GitDiffInspector, type GitProcessExecutor } from './git-diff.js'

const NUL = String.fromCharCode(0)
const servers: Server[] = []

function repoExecutor(): GitProcessExecutor {
  return async (file, args) => {
    if (file === 'gh') {
      return {
        stdout: JSON.stringify({
          number: 42,
          title: 'Show pull requests in pane footers',
          url: 'https://github.com/example/commando/pull/42',
          state: 'OPEN',
          isDraft: false,
        }),
        stderr: '',
      }
    }
    if (file === 'difft') return { stdout: 'DIFT-OUTPUT', stderr: '' }
    const joined = args.join(' ')
    if (joined === 'rev-parse --show-toplevel --abbrev-ref HEAD') {
      return { stdout: '/repo\nfeature\n', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (args[3] === 'main^{commit}') return { stdout: 'sha\n', stderr: '' }
      throw new GitCommandFailure('git failed', '', false)
    }
    if (args[0] === 'merge-base') return { stdout: 'base\n', stderr: '' }
    if (args[0] === 'for-each-ref' && args[1]?.startsWith('--format=%(objectname)')) {
      return { stdout: 'mainsha\tmain\t\n', stderr: '' }
    }
    if (args[0] === 'for-each-ref') return { stdout: 'main\norigin/main\n', stderr: '' }
    if (args[0] === 'rev-list' && args[1] === '--boundary') {
      return { stdout: 'uniquesha\n-basesha\n', stderr: '' }
    }
    if (args[0] === 'rev-list' && args[1] === '--no-walk=sorted') {
      return { stdout: 'basesha\n', stderr: '' }
    }
    if (args[0] === 'name-rev') return { stdout: 'main\n', stderr: '' }
    if (args.includes('--numstat')) return { stdout: `3\t1\ta.ts${NUL}`, stderr: '' }
    if (args.includes('--name-status')) return { stdout: `M${NUL}a.ts${NUL}`, stderr: '' }
    if (args[0] === 'ls-files') return { stdout: '', stderr: '' }
    if (args[0] === 'diff' && args[1] === '--ext-diff') return { stdout: 'STRUCTURAL', stderr: '' }
    throw new Error(`Unexpected command: ${file} ${joined}`)
  }
}

async function startApi(executor: GitProcessExecutor = repoExecutor()): Promise<string> {
  const api = new GitDiffApi({
    inspector: new GitDiffInspector(executor, {}),
    panePath: (paneId) => (paneId === '%1' ? '/repo' : undefined),
  })
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!(await api.handle(request, response, url))) {
        response.writeHead(404)
        response.end()
      }
    })()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve)),
  ))
})

describe('GitDiffApi', () => {
  it('returns a summary for a known pane', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/summary?paneId=%251`)
    expect(response.status).toBe(200)
    const body = await response.json() as { files: unknown[] }
    expect(body).toMatchObject({
      isRepo: true,
      branch: 'feature',
      target: 'main @ basesha',
      targetMode: 'auto',
      additions: 3,
      deletions: 1,
      pullRequest: {
        number: 42,
        title: 'Show pull requests in pane footers',
        url: 'https://github.com/example/commando/pull/42',
        isDraft: false,
      },
    })
    expect(body.files).toHaveLength(1)
  })

  it('rejects invalid pane ids', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/summary?paneId=abc`)
    expect(response.status).toBe(400)
  })

  it('404s panes the daemon does not know', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/summary?paneId=%2599`)
    expect(response.status).toBe(404)
  })

  it('rejects non-GET methods', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/summary?paneId=%251`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('requires a file for file diffs and returns difftastic output', async () => {
    const base = await startApi()
    const missing = await fetch(`${base}/api/git/file-diff?paneId=%251`)
    expect(missing.status).toBe(400)

    const response = await fetch(`${base}/api/git/file-diff?paneId=%251&file=a.ts&width=120`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ file: 'a.ts', diff: 'STRUCTURAL' })
  })

  it('lists branches for a known pane', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/branches?paneId=%251`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      isRepo: true,
      current: 'feature',
      branches: ['main', 'origin/main'],
    })
  })

  it('rejects unknown engines and layouts', async () => {
    const base = await startApi()
    const badEngine = await fetch(`${base}/api/git/file-diff?paneId=%251&file=a.ts&engine=meld`)
    expect(badEngine.status).toBe(400)
    const badDisplay = await fetch(`${base}/api/git/file-diff?paneId=%251&file=a.ts&display=unified`)
    expect(badDisplay.status).toBe(400)
  })

  it('maps unknown targets to 400', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/git/summary?paneId=%251&target=nope`)
    expect(response.status).toBe(400)
  })

  it('ignores unrelated paths', async () => {
    const base = await startApi()
    const response = await fetch(`${base}/api/other`)
    expect(response.status).toBe(404)
  })
})
