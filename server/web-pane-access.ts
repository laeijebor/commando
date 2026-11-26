import { redlineArtifactId } from '../shared/chat-tile-events.js'
import { isReadOnlyWebPane, type WebPane, type WebPanePendingSnapshot } from '../shared/protocol.js'
import type { RedlinePageResponse } from '../shared/redline-response.js'
import type { WebPanePendingStore } from './web-pane-pending.js'
import type { ChromiumEngine } from './chromium-engine.js'

export function isReadOnlyArtifactUrl(url: string, readOnlyArtifact?: (id: string) => boolean): boolean {
  const id = redlineArtifactId(url)
  return !!id && !!readOnlyArtifact?.(id)
}

/** Artifact protection still applies when an older or separately opened tab lacks pane flags. */
export function isReadOnlyArtifactPane(pane: WebPane | undefined, readOnlyArtifact?: (id: string) => boolean): boolean {
  if (!pane) return false
  const id = pane.content && pane.content.kind !== 'simulator' ? pane.content.artifactId : redlineArtifactId(pane.url)
  return isReadOnlyWebPane(pane) || !!id && !!readOnlyArtifact?.(id)
}

/** The SDK binding is another write ingress, independent of the HTTP API and connected viewers. */
export function createPageResponseHandler(deps: {
  pane: (id: string) => WebPane | undefined
  readOnlyArtifact: (id: string) => boolean
  pending: Pick<WebPanePendingStore, 'addResponse'>
  publish: (id: string, snapshot: WebPanePendingSnapshot) => void
}) {
  return (id: string, response: RedlinePageResponse, pageUrl: string): void => {
    const pane = deps.pane(id)
    if (!pane || isReadOnlyArtifactPane(pane, deps.readOnlyArtifact) || isReadOnlyArtifactUrl(pageUrl, deps.readOnlyArtifact)) return
    deps.publish(id, deps.pending.addResponse(id, pageUrl, response))
  }
}

/** A restored pane keeps its id, so discard the target cached under that id before reconnecting. */
export function invalidateRestoredWebPane(engine: Pick<ChromiumEngine, 'clearPendingSnapshot' | 'closeTile'>, relay: { dropTile: (id: string) => void }, pane: WebPane): void {
  engine.clearPendingSnapshot(pane.id)
  engine.closeTile(pane.id)
  relay.dropTile(pane.id)
}
