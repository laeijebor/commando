import { useDaemonStore } from '../daemon/store'
import { GIT_SUMMARY, PANE_PRS } from '../testing/fixtures'
import { demoIdentities } from './seed'
import type { DaemonFetchInit } from '../hosts/api'
import type { DemoDaemonClient } from './client'
import { DEMO_HOST_ID } from './flags'
import { demoGuideRoute } from './guide'

/** Unsupported demo routes fail locally; never let a fixture host reach the network. */
export function demoResponse(path: string, _init: DaemonFetchInit): Response {
  if (!__DEV__) throw new Error('Demo is only available in development')
  const url = new URL(path, 'http://demo:4310')
  const guide = demoGuideRoute(url.pathname, _init.method ?? 'GET', _init.body)
  if (guide) {
    const client = (require('../daemon/client') as typeof import('../daemon/client')).clientForHost(DEMO_HOST_ID) as DemoDaemonClient | undefined
    if (guide.events?.length) setTimeout(() => guide.events!.forEach((event) => client?.emitDemo(event)), 0)
    if (guide.later) setTimeout(() => guide.later!.events().forEach((event) => client?.emitDemo(event)), guide.later.delayMs)
    return guide.text !== undefined
      ? new Response(guide.text, { status: guide.status, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
      : new Response(JSON.stringify(guide.body), { status: guide.status, headers: { 'Content-Type': 'application/json' } })
  }
  let body: unknown
  if (url.pathname === '/api/health') body = { ok: true, sessions: 8 }
  else if (url.pathname === '/api/session-management/preferences') body = { preferences: { sessionIdentities: demoIdentities() } }
  else if (url.pathname === '/api/git/summary') body = { ...GIT_SUMMARY, branch: 'feat/remote-chat', files: [{ path: 'apps/mobile/src/chat/ChatView.tsx', status: 'M', additions: 18, deletions: 4, binary: false }], additions: 18, deletions: 4 }
  else if (url.pathname === '/api/git/file-diff') body = { file: url.searchParams.get('file'), diff: 'diff --git a/ChatView.tsx b/ChatView.tsx\n@@ -1 +1,2 @@\n-<Terminal />\n+<ChatTimeline />\n+<PaneTabs />' }
  else if (url.pathname === '/api/prs/pane') body = { list: { ...PANE_PRS, pullRequests: PANE_PRS.pullRequests.map((pr) => ({ ...pr, title: 'Bring remote chat to the companion', number: 257, createdAt: new Date(Date.now() - 3_600_000).toISOString(), updatedAt: new Date(Date.now() - 120_000).toISOString() })) } }
  else if (url.pathname === '/api/prs') body = { list: { repo: 'leo/commando', pullRequests: [] } }
  else if (/^\/api\/web-panes\/[^/]+\/seen$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/')[3]!)
    for (const [hostId, state] of Object.entries(useDaemonStore.getState().byHost)) {
      if (state.webPanes.some((tile) => tile.id === id)) useDaemonStore.getState().ingest(hostId, { type: 'web_panes', webPanes: state.webPanes.map((tile) => tile.id === id ? { ...tile, unseen: false } : tile) })
    }
    body = { ok: true }
  }
  else if (url.pathname.startsWith('/api/push/')) body = { ok: true }
  else return new Response(JSON.stringify({ error: 'This action is unavailable in the demo host.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
