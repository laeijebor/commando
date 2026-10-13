import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'
import { GitDiffApi } from './git-api.js'
import { GitCommandFailure, GitDiffInspector, type GitProcessExecutor } from './git-diff.js'

function comparisonApi(remotes: Record<string, string> = { origin: 'git@github.com:acme/widgets.git' }, refs = ['refs/remotes/origin/main^{commit}', 'head^{commit}']) {
  const execute = vi.fn<GitProcessExecutor>(async (_file, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: '/repo\nfeature\n', stderr: '' }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (refs.includes(args[3])) return { stdout: 'sha\n', stderr: '' }
      throw new GitCommandFailure('Unknown ref', '', false)
    }
    if (args.join(' ') === 'remote') return { stdout: Object.keys(remotes).join('\n'), stderr: '' }
    if (args[0] === 'remote' && args[1] === 'get-url') return { stdout: remotes[args[2]] ?? '', stderr: '' }
    if (args[0] === 'merge-base') return { stdout: 'branch-point\n', stderr: '' }
    if (args.includes('--numstat')) return { stdout: '1\t0\ta.ts\0', stderr: '' }
    if (args.includes('--name-status')) return { stdout: 'M\0a.ts\0', stderr: '' }
    if (args[0] === 'diff') return { stdout: 'STRUCTURAL', stderr: '' }
    throw new Error(`Unexpected command: ${args.join(' ')}`)
  })
  const api = new GitDiffApi({ inspector: new GitDiffInspector(execute, {}), panePath: () => '/repo' })
  const request = { method: 'GET' } as IncomingMessage
  const response = { writeHead: vi.fn(), end: vi.fn() }
  return { execute, api, request, response }
}

it.each(['summary', 'file-diff', 'search'])('routes the base fallback through comparison %s without fetching', async (route) => {
  const { execute, api, request, response } = comparisonApi()
  const url = new URL(`http://localhost/api/git/${route}?paneId=%251&target=missing-base&head=head&baseFallbackRepo=acme%2Fwidgets&baseFallbackBranch=main&file=a.ts&query=needle`)
  await api.handle(request, response as unknown as ServerResponse, url)
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  expect(execute.mock.calls.some(([, args]) => args.join(' ') === 'merge-base refs/remotes/origin/main head')).toBe(true)
  expect(execute.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false)
  if (route === 'file-diff') expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ file: 'a.ts', diff: 'STRUCTURAL' })
})

it('keeps a missing comparison head as an API error after the base fallback resolves', async () => {
  const { api, request, response } = comparisonApi()
  await api.handle(request, response as unknown as ServerResponse,
    new URL('http://localhost/api/git/summary?paneId=%251&target=missing-base&head=missing-head&baseFallbackRepo=acme%2Fwidgets&baseFallbackBranch=main'))
  expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ error: 'Unknown git ref: missing-head' })
})
