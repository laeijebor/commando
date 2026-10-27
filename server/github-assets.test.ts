import { describe, expect, it, vi } from 'vitest'
import { fetchGithubAsset, githubAssetUrl, MAX_GITHUB_ASSET_BYTES } from './github-assets.js'
import { PrService } from './prs.js'

const ASSET = 'https://github.com/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><style>@keyframes a{}</style></svg>'

function svgResponse(body = SVG, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'image/svg+xml', ...headers } })
}

describe('githubAssetUrl', () => {
  it('accepts GitHub attachment URLs and drops query strings and fragments', () => {
    expect(githubAssetUrl(ASSET)).toBe(ASSET)
    expect(githubAssetUrl(`${ASSET}?raw=1#x`)).toBe(ASSET)
    expect(githubAssetUrl('https://github.com/acme/widgets/assets/16110181/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f'))
      .toBe('https://github.com/acme/widgets/assets/16110181/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f')
  })

  it('rejects anything that is not a GitHub attachment', () => {
    for (const value of [
      'http://github.com/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f',
      'https://github.com.evil.test/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f',
      'https://user@github.com/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f',
      'https://github.com:8443/user-attachments/assets/ae328c6b-f0ea-4b47-8b77-ad5ae9424e6f',
      'https://github.com/user-attachments/assets/../../settings',
      'https://github.com/acme/widgets/raw/main/logo.png',
      'https://img.shields.io/badge/x',
      'not a url',
      42,
    ]) expect(githubAssetUrl(value)).toBeNull()
  })
})

describe('fetchGithubAsset', () => {
  it('sends the token and returns the image bytes and type', async () => {
    const fetcher = vi.fn(async () => svgResponse(SVG, { 'Content-Type': 'image/svg+xml; charset=utf-8' }))
    const asset = await fetchGithubAsset(ASSET, 'gho_secret', fetcher as unknown as typeof fetch)
    expect(asset.contentType).toBe('image/svg+xml')
    expect(asset.bytes.toString()).toBe(SVG)
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ Authorization: 'token gho_secret' })
    expect(init.redirect).toBe('follow')
  })

  it('refuses non-images, oversized images and missing assets', async () => {
    const run = (response: Response) => fetchGithubAsset(ASSET, 't', (async () => response) as unknown as typeof fetch)
    await expect(run(new Response('<html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ status: 415 })
    await expect(run(svgResponse(SVG, { 'Content-Length': String(MAX_GITHUB_ASSET_BYTES + 1) }))).rejects.toMatchObject({ status: 413 })
    await expect(run(new Response('Not Found', { status: 404 }))).rejects.toMatchObject({ status: 404, code: 'asset_not_found' })
    await expect(run(new Response('', { status: 500 }))).rejects.toMatchObject({ status: 502 })
  })
})

describe('PrService.githubAsset', () => {
  it('downloads each attachment once with the cached gh token', async () => {
    const runner = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'auth token') return 'gho_secret\n'
      throw new Error(`unexpected gh ${args.join(' ')}`)
    })
    const fetcher = vi.fn(async () => svgResponse())
    const service = new PrService({ runner, assetFetcher: fetcher as unknown as typeof fetch, preferencesPath: '/nonexistent/prs.json' })
    const [first, second] = await Promise.all([service.githubAsset(ASSET), service.githubAsset(`${ASSET}?x=1`)])
    expect(first).toBe(second)
    await service.githubAsset(ASSET)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('retries after a failure and never runs gh for a rejected URL', async () => {
    const runner = vi.fn(async () => 'gho_secret\n')
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(svgResponse())
    const service = new PrService({ runner, assetFetcher: fetcher as unknown as typeof fetch, preferencesPath: '/nonexistent/prs.json' })
    await expect(service.githubAsset('https://evil.test/a.svg')).rejects.toMatchObject({ status: 400 })
    expect(runner).not.toHaveBeenCalled()
    await expect(service.githubAsset(ASSET)).rejects.toMatchObject({ status: 502 })
    await expect(service.githubAsset(ASSET)).resolves.toMatchObject({ contentType: 'image/svg+xml' })
  })

  it('stays off GitHub on a daemon with GitHub disabled', async () => {
    const fetcher = vi.fn()
    const service = new PrService({ githubDisabledReason: 'off', assetFetcher: fetcher as unknown as typeof fetch, preferencesPath: '/nonexistent/prs.json' })
    await expect(service.githubAsset(ASSET)).rejects.toMatchObject({ status: 503, code: 'github_disabled' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
