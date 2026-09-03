import type { PaneScreenshotFile, PaneScreenshotFolder } from '../shared/protocol'

export type PaneScreenshotListing = PaneScreenshotFolder & { files: PaneScreenshotFile[] }

export type PaneScreenshotsApiClient = ReturnType<typeof createPaneScreenshotsApi>

export class PaneScreenshotsApiError extends Error {
  constructor(readonly code: 'not_found' | 'request_failed', message: string) {
    super(message)
  }
}

export function paneScreenshotUrl(folderId: string, name: string, modifiedAt: number): string {
  return `/screenshots/${folderId}/${encodeURIComponent(name)}?v=${encodeURIComponent(modifiedAt)}`
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
      if (response.status === 404) throw new PaneScreenshotsApiError('not_found', body.error ?? 'Folder not found')
      if (!response.ok || !body.folder) throw new PaneScreenshotsApiError('request_failed', body.error ?? `Screenshot listing failed (${response.status})`)
      return body.folder
    },
  }
}
