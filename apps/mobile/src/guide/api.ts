import { daemonFetch, DaemonHttpError } from '../hosts/api'
import type { Host } from '../hosts/types'
import { guideApiPath, guideFilePath, type GuideContent, type GuideSnapshot } from './model'

/**
 * The daemon's guide routes, called with the same payloads as the desktop's
 * src/guideApi.ts. Every call answers with the whole snapshot, so a caller
 * never has to merge a partial reply.
 */
async function guideCall(host: Host, path: string, init: { method?: string; body?: unknown } = {}): Promise<GuideSnapshot> {
  const response = await daemonFetch(host, path, init)
  const body = await response.json().catch(() => null) as { guide?: GuideSnapshot; error?: string } | null
  if (!response.ok || !body?.guide) throw new DaemonHttpError(response.status, body?.error ?? `Guide request failed (${response.status})`)
  return body.guide
}

export const fetchGuide = (host: Host, webPaneId: string) => guideCall(host, guideApiPath(webPaneId))

/** `{ id, checked }` ticks, `{ id, note }` annotates; the daemon trims the note and keeps the other half. */
export const markGuideStep = (host: Host, webPaneId: string, change: { id: string; checked?: boolean; note?: string }) =>
  guideCall(host, guideApiPath(webPaneId, '/steps'), { method: 'POST', body: change })

/** "Update agent": the daemon pastes the changes into the anchor pane once its agent is idle. */
export const requestGuideUpdate = (host: Host, webPaneId: string) => guideCall(host, guideApiPath(webPaneId, '/update'), { method: 'POST', body: {} })

export const cancelGuideUpdate = (host: Host, webPaneId: string) => guideCall(host, guideApiPath(webPaneId, '/update'), { method: 'DELETE' })

export const resetGuide = (host: Host, webPaneId: string) => guideCall(host, guideApiPath(webPaneId, '/reset'), { method: 'POST', body: {} })

/** The guide's Markdown, from the folder the daemon serves for it. */
export async function fetchGuideMarkdown(host: Host, content: GuideContent): Promise<string> {
  const response = await daemonFetch(host, guideFilePath(content))
  if (!response.ok) throw new DaemonHttpError(response.status, response.status === 404 ? `${content.file} is no longer available on the host` : `${content.file}: could not load (${response.status})`)
  return response.text()
}
