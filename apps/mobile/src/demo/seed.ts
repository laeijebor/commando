import type { AgentProvider, AgentStatus, CommandoSnapshot, ServerMessage, SessionBrief, WebPane } from '@commando/protocol'
import type { ChatProvider, ChatState } from '@commando/agent-chat'
import { deriveSessionIdentity } from '@commando/session-identity'
import { SNAPSHOT, NEEDS_INPUT_STATUS, WORKING_STATUS, BRIEFS } from '../testing/fixtures'
import { chatState, item, session } from '../chat/testing'
import { DEMO_GUIDE } from './guide'
import { DEMO_SUBAGENT_PANE, demoExternalRuns, demoSubagentItems } from './subagents'

export function demoMessages(now = Date.now()): ServerMessage[] {
  if (!__DEV__) throw new Error('Demo is only available in development')
  const names = ['remote-chat', 'pane-tabs', 'feedback-retry', 'design-review', 'auth-refresh', 'native-preview', 'release-journal', 'search-garden']
  const repos = ['commando', 'commando', 'lavish', 'lavish', 'atlas', 'atlas', 'island', 'island']
  // The ninth (the extra pane) is the Claude chat that fans out to subagents.
  const providers: AgentProvider[] = ['claude', 'codex', 'cursor', 'muse', 'codex', 'claude', 'muse', 'cursor', 'claude']
  const kinds: AgentStatus['status'][] = ['needs_input', 'working', 'working', 'done', 'failed', 'stale', 'done', 'done']
  const sessions = names.map((name, index) => ({ id: `$demo${index}`, name, attached: index === 0, activeWindowId: `@demo${index}`, windowIds: [`@demo${index}`] }))
  const panes = names.map((_, index) => ({ ...SNAPSHOT.panes[0]!, id: `%demo${index}`, targetId: `%demo${index}`, sessionId: sessions[index]!.id, windowId: `@demo${index}`, title: index === 0 ? 'Remote chat' : names[index]!, command: providers[index]!, path: `/demo/${repos[index]}`, repo: { root: `/demo/${repos[index]}`, name: repos[index]!, branch: index === 0 ? 'feat/remote-chat' : `feat/${names[index]}`, isWorktree: true } }))
  // One multi-agent session exercises indented agent rows.
  panes.push({ ...panes[1]!, id: '%demo-extra', targetId: '%demo-extra', title: 'Fan out the subagent work', index: 1 })
  const snapshot: CommandoSnapshot = { revision: 57, capturedAt: now, sessions, panes, windows: sessions.map((s) => ({ id: s.activeWindowId!, sessionId: s.id, index: 0, name: 'agent', active: true, layout: '', paneIds: panes.filter((p) => p.sessionId === s.id).map((p) => p.id) })), ports: [{ port: 5273, processName: 'vite', sessionId: sessions[0]!.id, paneId: panes[0]!.id }] }
  const headlines = ['Choose the reply layout', 'Connecting pane tabs to the worklog', 'Checking the retry boundary', 'New review flow is ready', 'Token refresh test found an edge case', 'Preview is waiting on the build', 'Release notes shipped', 'Search indexing is ready']
  const statuses: AgentStatus[] = panes.map((pane, i) => ({ ...(i === 0 ? NEEDS_INPUT_STATUS : WORKING_STATUS), paneId: pane.id, provider: providers[i] ?? 'muse', status: kinds[i] ?? 'working', summary: headlines[i] ?? 'Reviewing tab ownership', updatedAt: now - i * 70_000, settledAt: i === 3 || i === 6 ? now - i * 70_000 : undefined, details: { recentActivities: [], checks: [], ...(i === 0 ? { requests: [{ ...NEEDS_INPUT_STATUS.details!.requests![0]!, prompt: headlines[0]!, questions: [{ header: 'Layout', question: 'How should the reply read?', options: [{ label: 'Quiet and spacious', description: 'Flat replies, room for code' }, { label: 'Compact', description: 'More turns on screen' }], multiple: false, custom: true }] }] } : {}), ...(i === 6 ? { recap: { outcome: 'done' as const, declared: true as const, summary: 'Release notes shipped', completedAt: now - 420_000 } } : {}) } }))
  const briefs: SessionBrief[] = statuses.map((status, i) => ({ ...BRIEFS['%14']!, paneId: status.paneId, targetId: status.paneId, sessionId: panes[i]!.sessionId, sessionName: sessions[Math.min(i, 7)]!.name, state: status.status, headline: headlines[i] ?? status.summary, recapMarkdown: 'The remote conversation now follows the same visual rhythm as the desktop.\n\n- Native chat with clear activity summaries\n- Pane context stays one tap away', next: 'Review the phone layout and send a reply', tasks: [{ id: 'one', content: 'Connect the native timeline', status: 'completed', priority: 'high' }, { id: 'two', content: 'Polish the pane tabs', status: 'in_progress', priority: 'medium' }], updatedAt: status.updatedAt, updates: [{ id: 'demo-check', paneId: status.paneId, source: 'hook', kind: 'check', text: 'Timeline and navigation checks passed', createdAt: now - 80_000 }] }))
  const chats: ChatState[] = panes.map((pane, i) => {
    // The daemon can send new provider strings before the shared union catches up.
    const provider = (providers[i] ?? 'muse') as ChatProvider
    const items = [
      item('user_message', { text: 'Bring the desktop chat experience to my phone. Keep the progress easy to scan.', createdAt: now - 240_000 }),
      item('reasoning', { text: 'I’m checking the existing chat channel and the desktop visual hierarchy before changing the phone layout.', createdAt: now - 230_000, updatedAt: now - 216_000 }),
      item('tool', { toolUseId: 'read', toolName: 'Read', title: `Read /demo/${repos[i] ?? 'commando'}/ChatView.tsx` }),
      item('file_change', { toolUseId: 'edit', toolName: 'Edit', path: `/demo/${repos[i] ?? 'commando'}/ChatView.tsx`, additions: 18, deletions: 4, patch: '@@ -1,2 +1,3 @@\n-<Terminal />\n+<ChatTimeline />\n+<PaneTabs />' }),
      item('command', { toolUseId: 'check', command: 'npm run typecheck', output: 'TypeScript: no errors' }),
      item('assistant_message', { text: 'The first pass is ready. **Your chats keep their desktop identity**, with a quieter timeline and the pane’s context close by.\n\n```tsx\n<ChatTimeline items={chat.items} provider={chat.session.provider} />\n```\n\nNext I’ll check the spacing on iPhone and iPad.' }),
      item('plan', { toolUseId: 'plan', text: '# Remote chat\n\n1. Match the desktop session hierarchy\n2. Keep messages and activity readable\n3. Bring pane tabs into the conversation' }),
      item('todo_list', { todos: [{ content: 'Session identities', status: 'completed' }, { content: 'Pane tabs', status: 'in_progress' }, { content: 'Phone screenshots', status: 'pending' }] }),
    ]
    if (i === 5) {
      const progress = [
        ['Check the phone layout while the keyboard is open.', 'The conversation now has a bounded viewport between the pane tabs and the composer. Opening the keyboard reduces that viewport instead of covering the transcript. The first message keeps its normal top margin when the conversation is short, and longer conversations can scroll through every turn without moving the composer.'],
        ['How does the conversation follow a new reply?', 'When you send a message, the conversation reveals the newest turn. While you are already near the bottom, incoming reply chunks keep the same view pinned as the text grows. You can keep typing while the agent works; keyboard and composer size changes leave the latest part of the conversation above the input field.'],
        ['Let me read the earlier progress before continuing.', 'Scroll up to inspect the earlier notes, tool activity, and code example. New messages should leave your reading position alone. The jump button brings you back to the latest turn when you are ready. Try this while a reply is streaming so that there is enough new content to make a lost reading position obvious.'],
        ['Summarise what I should verify on the simulator.', 'Open this chat with the keyboard down, then focus the composer and send a short message. The latest user bubble and the assistant reply should stay visible above it. Next, scroll toward the beginning and send another message after returning to the bottom. Worklog and Changes stay available in the pane tabs throughout the conversation.'],
      ]
      progress.forEach(([prompt, reply], index) => {
        const at = now - 120_000 + index * 20_000
        const turnId = `demo-layout-${index}`
        items.push(item('user_message', { text: prompt!, turnId, createdAt: at, updatedAt: at }))
        items.push(item('assistant_message', { text: reply!, turnId, createdAt: at + 1_000, updatedAt: at + 5_000 }))
      })
    }
    if (pane.id === DEMO_SUBAGENT_PANE) items.push(...demoSubagentItems(now))
    if (i === 0) items.push(item('request', { status: 'running', requestId: 'demo-question', requestKind: 'question', toolName: 'AskUserQuestion', title: 'Choose the reply layout', questions: [{ header: 'Layout', question: 'How should the reply read?', options: [{ label: 'Quiet and spacious', description: 'Flat replies, room for code' }, { label: 'Compact' }], multiSelect: false }] }))
    return chatState({ paneId: pane.id, session: session({ paneId: pane.id, provider, cwd: pane.path, status: i === 0 ? 'waiting' : pane.id === DEMO_SUBAGENT_PANE ? 'running' : kinds[i] === 'working' ? 'running' : kinds[i] === 'failed' ? 'error' : 'idle', title: headlines[i] ?? pane.title, error: kinds[i] === 'failed' ? 'The token expired while the refresh test was running.' : undefined, permissionMode: providers[i] === 'cursor' ? undefined : 'default', effort: undefined, models: undefined, model: undefined }), items })
  })
  const webPanes: WebPane[] = [
    { id: 'demo-browser', title: 'Companion preview', url: 'http://localhost:5273', sessionId: sessions[0]!.id, windowId: '@demo0', anchorPaneId: '%demo0', placement: 'right', dock: 'panel', order: 1, unseen: true, engine: 'chromium', openedBy: 'agent', status: 'open', createdAt: now - 60_000 },
    { id: 'demo-simulator', title: 'iPhone preview', url: '', content: { kind: 'simulator', udid: 'demo-iphone' }, sessionId: sessions[0]!.id, windowId: '@demo0', anchorPaneId: '%demo0', placement: 'right', dock: 'panel', order: 2, engine: 'webkit', openedBy: 'agent', status: 'open', createdAt: now - 50_000 },
    { id: 'demo-canvas', title: 'Layout study', url: '', content: { kind: 'canvas', artifactId: 'demo', manifest: 'canvas.json' }, sessionId: sessions[0]!.id, windowId: '@demo0', anchorPaneId: '%demo0', placement: 'right', dock: 'panel', order: 3, engine: 'webkit', openedBy: 'agent', status: 'open', createdAt: now - 40_000 },
    { id: DEMO_GUIDE.id, title: 'Review checklist', url: '', content: { kind: 'guide', artifactId: DEMO_GUIDE.artifactId, file: DEMO_GUIDE.file }, sessionId: sessions[0]!.id, windowId: '@demo0', anchorPaneId: '%demo0', placement: 'right', dock: 'panel', order: 4, engine: 'webkit', openedBy: 'agent', status: 'open', createdAt: now - 30_000 },
  ]
  return [{ type: 'snapshot', snapshot }, { type: 'agent_status_snapshot', statuses }, { type: 'session_brief_snapshot', briefs }, { type: 'chat_snapshot', chats }, { type: 'web_panes', webPanes }, { type: 'chat_external_runs', paneId: DEMO_SUBAGENT_PANE, runs: demoExternalRuns(now) }]
}
export function demoIdentities(): Record<string, ReturnType<typeof deriveSessionIdentity>> {
  return Object.fromEntries(['remote-chat', 'pane-tabs', 'feedback-retry', 'design-review', 'auth-refresh', 'native-preview', 'release-journal', 'search-garden'].map((name) => [name, deriveSessionIdentity(name)]))
}
