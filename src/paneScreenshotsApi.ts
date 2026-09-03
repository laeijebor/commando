import type { PaneScreenshotFile, PaneScreenshotFolder } from '../shared/protocol'

export type PaneScreenshotListing = PaneScreenshotFolder & { files: PaneScreenshotFile[] }

export type PaneScreenshotsApiClient = ReturnType<typeof createPaneScreenshotsApi>

export function paneScreenshotUrl(folderId: string, name: string): string {
  return `/screenshots/${folderId}/${encodeURIComponent(name)}`
}

export function createPaneScreenshotsApi(token: string, fetcher: typeof fetch = fetch) {
  return {
    async list(folderId: string): Promise<PaneScreenshotListing> {
      const response = await fetcher(`/api/screenshots/${encodeURIComponent(folderId)}`, {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const body = await response.json().catch(() => ({})) as { error?: string; folder?: PaneScreenshotListing }
      if (!response.ok || !body.folder) throw new Error(body.error ?? `Screenshot listing failed (${response.status})`)
      return body.folder
    },
  }
}
