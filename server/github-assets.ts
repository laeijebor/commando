import { PrServiceError } from './prs.js'
export { githubAssetUrl } from '../shared/github-assets.js'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
export const MAX_GITHUB_ASSET_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

export type GithubAsset = { contentType: string; bytes: Buffer }

/**
 * Downloads an attachment with the gh user's token. GitHub answers with a
 * redirect to a short-lived signed download link; fetch drops the token there.
 */
export async function fetchGithubAsset(url: string, token: string, fetcher: typeof fetch = fetch): Promise<GithubAsset> {
  let response: Response
  try {
    response = await fetcher(url, {
      headers: { Authorization: `token ${token}`, Accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new PrServiceError(502, 'asset_unavailable', 'Could not download the image from GitHub')
  }
  if (response.status === 404 || response.status === 403) {
    throw new PrServiceError(404, 'asset_not_found', 'GitHub has no image at that address for this account')
  }
  if (!response.ok) throw new PrServiceError(502, 'asset_unavailable', `GitHub returned ${response.status} for the image`)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!IMAGE_TYPES.has(contentType)) throw new PrServiceError(415, 'asset_not_image', 'The attachment is not an image')
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_GITHUB_ASSET_BYTES) throw new PrServiceError(413, 'asset_too_large', 'The image is too large to show')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_GITHUB_ASSET_BYTES) throw new PrServiceError(413, 'asset_too_large', 'The image is too large to show')
  return { contentType, bytes }
}
