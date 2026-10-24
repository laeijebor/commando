import type { ChatItem, ExternalAgentRun } from '@commando/agent-chat'

import { item } from '../chat/testing'

/** The demo chat that fans out to subagents: the second Claude pane in the `pane-tabs` session. */
export const DEMO_SUBAGENT_PANE = '%demo-extra'

const TURN = 'demo-fanout'

/**
 * One turn that fans out: SDK subagents in every state (one finished with its
 * own live items, one in the background, one in the foreground, one failed and
 * one whose transcript is read from disk) and the `codex exec` / `claude -p`
 * commands the external runs anchor to.
 */
export function demoSubagentItems(now: number): ChatItem[] {
  const at = (ago: number) => now - ago
  const own = (parent: string, kind: ChatItem['kind'], fields: Record<string, unknown>, ago: number) =>
    item(kind, { turnId: TURN, parentToolUseId: parent, createdAt: at(ago), updatedAt: at(ago - 2_000), ...fields } as never)
  return [
    item('user_message', { turnId: TURN, text: 'Fan out: map the desktop subagent view, port the metrics line, run the tests, and get a second opinion from Codex.', createdAt: at(300_000), updatedAt: at(300_000) }),
    item('assistant_message', { turnId: TURN, text: 'I’ll split this across subagents so each part moves in parallel.', createdAt: at(296_000), updatedAt: at(295_000) }),
    item('subagent', {
      id: 'demo-sub-map', toolUseId: 'demo-sub-map', turnId: TURN, agentId: 'demo-agent-map', state: 'completed', status: 'completed',
      description: 'Map the desktop subagent view', subagentType: 'Explore', toolUses: 6, durationMs: 94_000,
      prompt: 'Find where the desktop chat renders subagents: the rows, the header, the switcher and how a transcript loads. Report file paths and the messages each one sends.',
      summary: 'Subagents.tsx draws rows, header and switcher; ChatPane loads transcripts with chat_subagent_transcript.',
      createdAt: at(294_000), updatedAt: at(200_000),
    }),
    own('demo-sub-map', 'tool', { toolUseId: 'demo-map-1', toolName: 'Grep', title: 'Grep SubagentGroup' }, 290_000),
    own('demo-sub-map', 'tool', { toolUseId: 'demo-map-2', toolName: 'Read', title: 'Read src/chat/Subagents.tsx' }, 280_000),
    own('demo-sub-map', 'tool', { toolUseId: 'demo-map-3', toolName: 'Read', title: 'Read src/chat/ChatPane.tsx' }, 260_000),
    own('demo-sub-map', 'command', { toolUseId: 'demo-map-4', command: 'rg chat_subagent_transcript server shared', output: 'server/index.ts:2565\nshared/protocol.ts:911' }, 240_000),
    own('demo-sub-map', 'assistant_message', { text: '**Rows, header and switcher** live in `src/chat/Subagents.tsx`. `ChatPane` keeps which agent is on screen and reads a finished subagent’s transcript with `chat_subagent_transcript` when none of its items are live.\n\nStop and Background go out as `chat_task`; external runs stop with `chat_external_stop`.' }, 205_000),
    item('subagent', {
      id: 'demo-sub-metrics', toolUseId: 'demo-sub-metrics', turnId: TURN, agentId: 'demo-agent-metrics', state: 'running', status: 'running', background: true,
      description: 'Port the metrics line', subagentType: 'general-purpose', toolUses: 3, lastToolName: 'Edit',
      prompt: 'Move the subagent metrics helpers into shared/ and draw the same line on the phone.',
      createdAt: at(250_000), updatedAt: at(5_000),
    }),
    own('demo-sub-metrics', 'tool', { toolUseId: 'demo-met-1', toolName: 'Read', title: 'Read src/chat/turnFlow.ts' }, 240_000),
    own('demo-sub-metrics', 'file_change', { toolUseId: 'demo-met-2', toolName: 'Write', path: 'shared/chat-subagents.ts', additions: 96, deletions: 0 }, 200_000),
    own('demo-sub-metrics', 'assistant_message', { text: 'The helpers are shared now; wiring the phone rows next.' }, 120_000),
    own('demo-sub-metrics', 'file_change', { toolUseId: 'demo-met-3', toolName: 'Edit', path: 'apps/mobile/src/chat/Subagents.tsx', additions: 41, deletions: 3, status: 'running' }, 8_000),
    item('subagent', {
      id: 'demo-sub-tests', toolUseId: 'demo-sub-tests', turnId: TURN, agentId: 'demo-agent-tests', state: 'running', status: 'running',
      description: 'Run the jest suite', subagentType: 'general-purpose', toolUses: 1, summary: 'Running jest in apps/mobile',
      prompt: 'Run `npx jest` in apps/mobile and report any failures with their file and test name.',
      createdAt: at(90_000), updatedAt: at(3_000),
    }),
    own('demo-sub-tests', 'command', { toolUseId: 'demo-tests-1', command: 'npx jest', status: 'running' }, 60_000),
    item('subagent', {
      id: 'demo-sub-ipad', toolUseId: 'demo-sub-ipad', turnId: TURN, agentId: 'demo-agent-ipad', state: 'failed', status: 'failed',
      description: 'Check the iPad cockpit', subagentType: 'Explore', toolUses: 2, durationMs: 31_000,
      summary: 'The simulator wasn’t booted, so the cockpit couldn’t be checked.',
      createdAt: at(280_000), updatedAt: at(249_000),
    }),
    item('subagent', {
      id: 'demo-sub-history', toolUseId: 'demo-sub-history', turnId: TURN, agentId: 'demo-agent-history', state: 'completed', status: 'completed',
      description: 'Read the PR history', subagentType: 'general-purpose', toolUses: 4, durationMs: 48_000,
      summary: 'Two earlier PRs touched subagents: #68 (external runs) and #41 (the switcher).',
      createdAt: at(292_000), updatedAt: at(244_000),
    }),
    item('command', { turnId: TURN, toolUseId: 'demo-codex', command: 'codex exec -m gpt-6.1 "Review the subagent rows for the phone"', createdAt: at(230_000), updatedAt: at(229_000) }),
    item('command', { turnId: TURN, toolUseId: 'demo-claude-p', command: 'claude -p "Summarise PR #68 for the release notes"', createdAt: at(228_000), updatedAt: at(227_000) }),
  ]
}

/** External runs the daemon "observed" next to the demo's commands. */
export function demoExternalRuns(now: number): ExternalAgentRun[] {
  return [
    {
      id: 'demo-run-codex', runtime: 'codex', label: 'Review the subagent rows for the phone', state: 'quiet',
      startedAt: now - 229_000, updatedAt: now - 200_000, lastEventAt: now - 200_000, model: 'gpt-6.1', effort: 'high',
      toolUses: 9, lastAction: 'Read apps/mobile/src/chat/ChatTimeline.tsx',
    },
    {
      id: 'demo-run-claude', runtime: 'claude', label: 'Summarise PR #68 for the release notes', state: 'completed',
      startedAt: now - 227_000, updatedAt: now - 180_000, finishedAt: now - 180_000, toolUses: 3, durationMs: 47_000,
      summary: 'External runs show in the subagent card and the switcher, with Stop.',
    },
  ]
}

/** The saved transcript of the subagent whose items aren't in the chat. */
export function demoSubagentTranscript(agentId: string): { items: ChatItem[]; error?: string } {
  if (agentId !== 'demo-agent-history') return { items: [], error: 'No saved transcript for this subagent' }
  const turnId = 'demo-history'
  return {
    items: [
      item('user_message', { turnId, text: 'List the merged PRs that changed how the chat shows subagents, newest first.' }),
      item('command', { turnId, toolUseId: 'demo-hist-1', command: 'gh pr list --state merged --search subagent', output: '#68  Cross-agent subagents in chat\n#41  Agent switcher' }),
      item('tool', { turnId, toolUseId: 'demo-hist-2', toolName: 'Read', title: 'Read docs/notes/cross-agent-subagents.md' }),
      item('assistant_message', { turnId, text: 'Two PRs:\n\n- **#68** added external `codex exec` / `claude -p` runs with Stop.\n- **#41** added the agent switcher and relayed messages.' }),
    ],
  }
}
