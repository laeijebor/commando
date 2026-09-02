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
