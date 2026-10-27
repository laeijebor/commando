/** Images GitHub serves for PR bodies and comments. On private repos they need the viewer's GitHub login. */
const ASSET_PATH = /^\/(?:user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets\/\d+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The canonical asset URL, or null when the URL is not a GitHub-hosted attachment. */
export function githubAssetUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null
  return ASSET_PATH.test(url.pathname) ? `https://github.com${url.pathname}` : null
}
