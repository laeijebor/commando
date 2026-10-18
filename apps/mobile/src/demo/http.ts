import { GIT_SUMMARY, PANE_PRS } from '../testing/fixtures'
import { demoIdentities } from './seed'
import type { DaemonFetchInit } from '../hosts/api'

/** Unsupported demo routes fail locally; never let a fixture host reach the network. */
export function demoResponse(path: string, _init: DaemonFetchInit): Response {
  if (!__DEV__) throw new Error('Demo is only available in development')
  const url = new URL(path, 'http://demo:4310')
  let body: unknown
  if (url.pathname === '/api/health') body = { ok: true, sessions: 8 }
  else if (url.pathname === '/api/session-management/preferences') body = { preferences: { sessionIdentities: demoIdentities() } }
  else if (url.pathname === '/api/git/summary') body = { ...GIT_SUMMARY, branch: 'feat/remote-chat', files: [{ path: 'apps/mobile/src/chat/ChatView.tsx', status: 'M', additions: 18, deletions: 4, binary: false }], additions: 18, deletions: 4 }
  else if (url.pathname === '/api/git/file-diff') body = { file: url.searchParams.get('file'), diff: 'diff --git a/ChatView.tsx b/ChatView.tsx\n@@ -1 +1,2 @@\n-<Terminal />\n+<ChatTimeline />\n+<PaneTabs />' }
  else if (url.pathname === '/api/prs/pane') body = { list: { ...PANE_PRS, pullRequests: PANE_PRS.pullRequests.map((pr) => ({ ...pr, title: 'Bring remote chat to the companion', number: 257 })) } }
  else if (url.pathname === '/api/prs') body = { list: { repo: 'leo/commando', pullRequests: [] } }
  else if (url.pathname.startsWith('/api/push/')) body = { ok: true }
  else return new Response(JSON.stringify({ error: 'This action is unavailable in the demo host.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
