import { describe, expect, it, vi } from 'vitest'
import { createGitDiffApi } from './gitApi'

describe('createGitDiffApi.repo', () => {
  it('asks the daemon which repository contains a directory', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ isRepo: true, mainRoot: '/repo', name: 'repo' }), { status: 200 }))
    const api = createGitDiffApi('secret', fetcher as unknown as typeof fetch)
    await expect(api.repo('/repo/apps')).resolves.toEqual({ isRepo: true, mainRoot: '/repo', name: 'repo' })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/git/repo?path=%2Frepo%2Fapps')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret')
  })
})

it('forwards the comparison base fallback on summary, file and search requests', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
  const api = createGitDiffApi('', fetcher as unknown as typeof fetch)
  await api.summary('%1', 'base-tip', 'head-tip', 'acme/widgets', 'main')
  await api.fileDiff('%1', 'a.ts', { target: 'base-tip', head: 'head-tip', baseFallbackRepo: 'acme/widgets', baseFallbackBranch: 'main' })
  await api.search('%1', 'needle', 'base-tip', 'head-tip', 'acme/widgets', 'main')
  for (const [input] of fetcher.mock.calls as unknown as Array<[string]>) {
    const params = new URL(input, 'http://localhost').searchParams
    expect(params.get('target')).toBe('base-tip')
    expect(params.get('head')).toBe('head-tip')
    expect(params.get('baseFallbackRepo')).toBe('acme/widgets')
    expect(params.get('baseFallbackBranch')).toBe('main')
    expect(params.has('baseFallback')).toBe(false)
  }
})
