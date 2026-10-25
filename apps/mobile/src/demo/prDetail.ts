import type { PrDetails, PrRemoteDiff } from '@commando/pr-quick-look'

import type { PrPreview } from '../pr/api'

/**
 * The demo host's one linked pull request, in full: the summary the pane list
 * carries as `preview`, the `/api/prs/details` description and conversation,
 * and the `/api/prs/diff` files — so the PR screens can be shown without GitHub.
 */

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const BASE = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567'
const minutes = (count: number) => new Date(Date.now() - count * 60_000).toISOString()

export function demoPrPreview(): PrPreview {
  return {
    number: 257,
    title: 'Bring remote chat to the companion',
    url: 'https://github.com/leo/commando/pull/257',
    state: 'open',
    isDraft: false,
    author: 'emerald-crab',
    additions: 1_062,
    deletions: 22,
    changedFiles: 6,
    commitCount: 9,
    unresolvedThreads: 2,
    reviewDecision: 'changes_requested',
    conflicting: false,
    checks: { state: 'pending', failed: 0, pending: 1, total: 4 },
    headRefName: 'feat/remote-chat',
    baseRefName: 'main',
    headRefOid: HEAD,
    baseRefOid: BASE,
    createdAt: minutes(240),
    updatedAt: minutes(2),
  }
}

const BODY = `<!-- commando:v1 target=%demo0 relation=created -->
## Summary

The companion now opens a pane as a **native chat** instead of a terminal: the same timeline, composer and activity summaries as the desktop, drawn with React Native views.

- Flat Markdown replies with scrollable code
- Foldable tool and thinking activity
- Queueing and steering while a turn runs

<img width="640" alt="Phone chat next to the desktop" src="https://github.githubassets.com/images/modules/open_graph/github-octocat.png" />

<details><summary>How the timeline is fed</summary>

The pane's chat channel replays the stored turns, then streams new items as the agent writes them.

</details>

## Test plan

- [x] \`npx tsc --noEmit\` and \`npx jest\`
- [x] Demo studio on iPhone 17 Pro
- [ ] Real daemon over Tailscale

\`\`\`sh
cd apps/mobile && npx jest src/chat
\`\`\`

| Surface | Before | After |
| --- | --- | --- |
| Pane | xterm | native chat |
| Info | sheet | sheet + tabs |
`

const CHAT_HUNK = `@@ -18,9 +18,14 @@ export function ChatView({ host, paneId }: ChatViewProps) {
   const chat = useChat(host, paneId)
   const theme = useTheme()
-  return <Terminal host={host} paneId={paneId} />
+  if (!chat.session) return <ChatSkeleton />
+  return (
+    <ChatTimeline
+      items={chat.items}
+      provider={chat.session.provider}`

export function demoPrDetails(): PrDetails {
  const now = Date.now()
  return {
    body: BODY,
    headOid: HEAD,
    mergeTarget: { branch: 'main', oid: BASE },
    unresolvedThreads: 2,
    fetchedAt: { metadata: now, conversation: now, checks: now },
    checks: [
      { name: 'typecheck', state: 'pass', url: '' },
      { name: 'unit tests', state: 'pass', url: '' },
      { name: 'mobile jest', state: 'pass', url: '' },
      { name: 'e2e (playwright)', state: 'pending', url: 'https://github.com/leo/commando/actions' },
    ],
    conversation: [
      { id: '0:1', kind: 'comment', author: 'leo', createdAt: minutes(230), url: '', body: 'Opening this early so the phone layout can be reviewed while the composer lands. Screenshots are in the description.' },
      { id: '0:2', kind: 'comment', author: 'coderabbitai[bot]', createdAt: minutes(225), url: '', body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough\n\nThe pane screen swaps its terminal for a **native chat timeline** when the pane runs a chat-capable agent.\n\n<details>\n<summary>📜 Recent review details</summary>\n\n- Files reviewed: 6\n- Comments: 3\n\n</details>\n<!-- end of auto-generated comment -->' },
      { id: '1:10', kind: 'changes requested', reviewId: 10, author: 'ocean-otter', createdAt: minutes(180), url: '', body: 'Nice start. Two things before this goes in: the skeleton flashes on every reconnect, and the code blocks wrap on iPhone.' },
      { id: '2:100', kind: 'inline comment', commentId: 100, reviewId: 10, author: 'ocean-otter', createdAt: minutes(180), url: '', path: 'apps/mobile/src/chat/ChatView.tsx', line: 21, diffHunk: CHAT_HUNK,
        body: 'This shows the skeleton again whenever the socket reconnects. Keep the last session on screen until the new one arrives?',
        thread: { id: 'PRRT_100', commentId: 100, isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false } },
      { id: '2:101', kind: 'inline comment', commentId: 101, replyTo: 100, reviewId: 11, author: 'emerald-crab', createdAt: minutes(150), url: '', path: 'apps/mobile/src/chat/ChatView.tsx', line: 21,
        body: 'Good catch — the store now keeps `session` across reconnects, so this only shows on first load.' },
      { id: '2:102', kind: 'inline comment', commentId: 102, replyTo: 100, reviewId: 12, author: 'ocean-otter', createdAt: minutes(120), url: '', path: 'apps/mobile/src/chat/ChatView.tsx', line: 21,
        body: 'Looks right. Leaving this open until the reconnect test is in.' },
      { id: '2:103', kind: 'inline comment', commentId: 103, reviewId: 10, author: 'ocean-otter', createdAt: minutes(179), url: '', path: 'apps/mobile/src/chat/Markdown.tsx', originalLine: 140,
        diffHunk: '@@ -136,6 +136,8 @@ function CodeBlock({ code }: { code: string }) {\n   return (\n     <View style={styles.code}>\n-      <Text style={styles.codeText}>{code}</Text>\n+      <ScrollView horizontal>\n+        <Text style={styles.codeText}>{code}</Text>',
        body: 'Code should scroll sideways rather than wrap.',
        thread: { id: 'PRRT_103', commentId: 103, isResolved: true, isOutdated: true, viewerCanReply: true, viewerCanResolve: false, viewerCanUnresolve: true } },
      { id: '2:104', kind: 'inline comment', commentId: 104, replyTo: 103, reviewId: 11, author: 'emerald-crab', createdAt: minutes(149), url: '', path: 'apps/mobile/src/chat/Markdown.tsx',
        body: 'Done in the latest push.' },
      { id: '2:105', kind: 'inline comment', commentId: 105, reviewId: 13, author: 'coderabbitai[bot]', createdAt: minutes(60), url: '', path: 'apps/mobile/src/chat/ChatComposer.tsx', line: 88,
        diffHunk: '@@ -84,4 +84,7 @@ export function ChatComposer({ onSend }: Props) {\n   const [draft, setDraft] = useState(\'\')\n+  const send = () => {\n+    onSend(draft)\n+    setDraft(\'\')',
        body: '_⚠️ Potential issue_\n\n**Clear the draft only after the send succeeds.** A failed send currently loses what the owner typed.\n\n```suggestion\n    void onSend(draft).then(() => setDraft(\'\'))\n```',
        thread: { id: 'PRRT_105', commentId: 105, isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: false } },
      { id: '1:14', kind: 'approved', reviewId: 14, author: 'amber-ibis', createdAt: minutes(20), url: '', body: '' },
    ],
  }
}

function generated(lines: number): string {
  const rows = [`@@ -0,0 +1,${lines} @@`]
  for (let index = 0; index < lines; index++) rows.push(`+export const TIMELINE_FIXTURE_${index} = { id: 'turn-${index}', kind: '${index % 3 === 0 ? 'user_message' : 'assistant_message'}', text: 'Fixture turn ${index} for the virtualised chat timeline' }`)
  return rows.join('\n')
}

export function demoPrDiff(): PrRemoteDiff {
  return {
    base: BASE,
    head: HEAD,
    truncated: false,
    files: [
      { path: 'apps/mobile/src/chat/ChatView.tsx', status: 'modified', additions: 12, deletions: 3, patch: `${CHAT_HUNK}\n+      onRetry={chat.retry}\n+    />\n+  )\n }\n \n export function ChatSkeleton() {\n@@ -60,7 +65,6 @@ function useChat(host: Host, paneId: string) {\n   const [items, setItems] = useState<ChatItem[]>([])\n-  const [error, setError] = useState<string | null>(null)\n   useEffect(() => subscribeChat(host, paneId, setItems), [host, paneId])\n   return { items, session: sessions.get(paneId), retry: () => reconnect(host, paneId) }\n }` },
      { path: 'apps/mobile/src/chat/Markdown.tsx', status: 'modified', additions: 18, deletions: 6, patch: '@@ -136,6 +136,8 @@ function CodeBlock({ code }: { code: string }) {\n   return (\n     <View style={styles.code}>\n-      <Text style={styles.codeText}>{code}</Text>\n+      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.codeContent} accessibilityLabel="Code">\n+        <Text selectable style={[styles.codeText, { color: theme.textSoft }]}>{code}</Text>\n+      </ScrollView>\n     </View>\n   )\n }' },
      { path: 'apps/mobile/src/chat/ChatComposer.tsx', status: 'modified', additions: 31, deletions: 12, patch: '@@ -84,4 +84,7 @@ export function ChatComposer({ onSend }: Props) {\n   const [draft, setDraft] = useState(\'\')\n+  const send = () => {\n+    onSend(draft)\n+    setDraft(\'\')\n+  }\n   return (\n     <View style={styles.composer}>' },
      { path: 'apps/mobile/src/chat/__fixtures__/timeline.ts', status: 'added', additions: 1_000, deletions: 0, patch: generated(1_000) },
      { path: 'apps/mobile/src/terminal/LegacyTerminal.tsx', status: 'renamed', additions: 1, deletions: 1, patch: '@@ -1,3 +1,3 @@\n-// The pane screen\n+// Terminal-only panes\n import { WebView } from \'react-native-webview\'' },
      { path: 'apps/mobile/assets/chat-empty.png', status: 'added', additions: 0, deletions: 0, patch: null },
    ],
  }
}
