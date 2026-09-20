import type {
  AgentStatus,
  CommandoSnapshot,
  PaneTerminalState,
  ProviderUsage,
  ServerMessage,
  SessionBrief,
  TmuxPane,
} from '@commando/protocol'

/**
 * Fixtures mirror the mockup's studio host: a commando session whose Claude
 * pane is asking a question, a Codex pane working in lavish, an OpenCode pane
 * running vitest in notes-vault and a finished Claude pane in island.
 */

const TERMINAL: PaneTerminalState = {
  width: 120,
  height: 40,
  cursorX: 0,
  cursorY: 0,
  alternateSavedX: 0,
  alternateSavedY: 0,
  alternateOn: false,
  cursorVisible: true,
  cursorShape: 'block',
  cursorBlinking: true,
  scrollRegionUpper: 0,
  scrollRegionLower: 39,
  wrapFlag: true,
  originFlag: false,
  insertFlag: false,
  keypadFlag: false,
  keypadCursorFlag: false,
  mouseAnyFlag: false,
  mouseSgrFlag: false,
  paneTabs: [],
}

export const NOW = 1_758_196_860_000

function pane(overrides: Partial<TmuxPane> & Pick<TmuxPane, 'id' | 'windowId' | 'sessionId'>): TmuxPane {
  return {
    ...TERMINAL,
    targetId: `%${overrides.id.replace('%', '')}`,
    processId: 4_200,
    index: 0,
    title: 'claude',
    command: 'claude',
    path: '/Users/leo/code/commando',
    active: true,
    dead: false,
    ...overrides,
  }
}

export const SNAPSHOT: CommandoSnapshot = {
  revision: 41,
  capturedAt: NOW,
  sessions: [
    { id: '$1', name: 'commando', attached: true, activeWindowId: '@1', windowIds: ['@1', '@2'] },
    { id: '$2', name: 'lavish', attached: false, activeWindowId: '@3', windowIds: ['@3'] },
    { id: '$3', name: 'notes-vault', attached: false, activeWindowId: '@4', windowIds: ['@4'] },
    { id: '$4', name: 'island', attached: false, activeWindowId: '@5', windowIds: ['@5'] },
  ],
  windows: [
    { id: '@1', index: 0, sessionId: '$1', name: 'island', active: true, layout: '', paneIds: ['%14'] },
    { id: '@2', index: 1, sessionId: '$1', name: 'server', active: false, layout: '', paneIds: ['%15'] },
    { id: '@3', index: 0, sessionId: '$2', name: 'agent', active: true, layout: '', paneIds: ['%20'] },
    { id: '@4', index: 0, sessionId: '$3', name: 'agent', active: true, layout: '', paneIds: ['%30'] },
    { id: '@5', index: 0, sessionId: '$4', name: 'agent', active: true, layout: '', paneIds: ['%40'] },
  ],
  panes: [
    pane({
      id: '%14',
      windowId: '@1',
      sessionId: '$1',
      targetId: '%14',
      title: 'claude',
      repo: {
        root: '/Users/leo/code/commando',
        name: 'commando',
        branch: 'feat/companion-app',
        isWorktree: false,
        defaultBranch: 'main',
      },
    }),
    pane({
      id: '%15',
      windowId: '@2',
      sessionId: '$1',
      targetId: '%15',
      index: 1,
      title: 'server',
      command: 'tsx',
      repo: {
        root: '/Users/leo/code/commando',
        name: 'commando',
        branch: 'feat/companion-app',
        isWorktree: false,
      },
    }),
    pane({
      id: '%20',
      windowId: '@3',
      sessionId: '$2',
      targetId: '%20',
      title: 'codex',
      command: 'codex',
      path: '/Users/leo/code/lavish',
      repo: {
        root: '/Users/leo/code/lavish',
        name: 'lavish',
        branch: 'feat/feedback-retry',
        isWorktree: true,
      },
    }),
    pane({
      id: '%30',
      windowId: '@4',
      sessionId: '$3',
      targetId: '%30',
      title: 'opencode',
      command: 'opencode',
      path: '/Users/leo/code/notes-vault',
      repo: {
        root: '/Users/leo/code/notes-vault',
        name: 'notes-vault',
        branch: 'main',
        isWorktree: false,
      },
    }),
    pane({
      id: '%40',
      windowId: '@5',
      sessionId: '$4',
      targetId: '%40',
      title: 'claude',
      path: '/Users/leo/code/island',
      repo: {
        root: '/Users/leo/code/island',
        name: 'island',
        branch: 'fix/visor-nonotch',
        isWorktree: true,
      },
    }),
  ],
  ports: [{ port: 4310, processName: 'node', sessionId: '$1', paneId: '%15' }],
}

export const NEEDS_INPUT_STATUS: AgentStatus = {
  paneId: '%14',
  provider: 'claude',
  agentSessionName: 'companion-app',
  status: 'needs_input',
  summary: 'Waiting on an answer',
  source: 'hook',
  confidence: 'high',
  reason: 'Notification hook reported a question',
  updatedAt: NOW - 4 * 60 * 1000,
  details: {
    intent: 'Design the companion app auth flow',
    recentActivities: [],
    checks: [],
    requests: [
      {
        id: 'req-1',
        kind: 'question',
        prompt: 'Which auth flow should the companion use?',
        createdAt: NOW - 4 * 60 * 1000,
        questions: [
          {
            header: 'Auth',
            question: 'Which auth flow should the companion use?',
            options: [
              { label: 'Owner email + password', description: 'Reuse the Better Auth cookie' },
              { label: 'Pairing QR', description: 'Daemon prints a one-time code' },
              { label: 'Automation token only' },
            ],
            multiple: false,
            custom: true,
          },
        ],
      },
    ],
  },
}

export const WORKING_STATUS: AgentStatus = {
  paneId: '%20',
  provider: 'codex',
  status: 'working',
  summary: 'Add retry to the feedback poll',
  source: 'heuristic',
  confidence: 'medium',
  reason: 'Codex process is busy',
  updatedAt: NOW - 12 * 60 * 1000,
  details: {
    recentActivities: [],
    checks: [],
    currentActivity: {
      label: '✎ src/poll.ts',
      kind: 'edit',
      state: 'running',
      updatedAt: NOW - 60 * 1000,
    },
    progress: { completed: 4, total: 7, active: 'Retry with backoff' },
  },
}

export const CHECKING_STATUS: AgentStatus = {
  paneId: '%30',
  provider: 'opencode',
  status: 'working',
  summary: 'Migrate vault picker to Markdown dirs',
  source: 'hook',
  confidence: 'high',
  reason: 'Tool use in flight',
  updatedAt: NOW - 31 * 60 * 1000,
  details: {
    recentActivities: [],
    checks: [{ label: '▶ vitest', status: 'running', updatedAt: NOW - 30 * 1000 }],
  },
}

export const DONE_STATUS: AgentStatus = {
  paneId: '%40',
  provider: 'claude',
  status: 'done',
  summary: 'Visor shortcut works on non-notch Macs',
  source: 'hook',
  confidence: 'high',
  reason: 'Stop hook fired',
  updatedAt: NOW - 2 * 60 * 60 * 1000,
  details: {
    recentActivities: [],
    checks: [],
    changes: { fileCount: 2, additions: 64, deletions: 12 },
    recap: {
      outcome: 'done',
      summary: '🟢 Visor shortcut works on non-notch Macs',
      completedAt: NOW - 2 * 60 * 60 * 1000,
    },
  },
}

export const FOLLOW_UP_STATUS: AgentStatus = {
  paneId: '%15',
  provider: 'claude',
  status: 'done',
  summary: 'Daemon restarted, ports rebound',
  source: 'hook',
  confidence: 'medium',
  reason: 'Stop hook fired with a follow-up recap',
  updatedAt: NOW - 45 * 60 * 1000,
  details: {
    recentActivities: [],
    checks: [],
    recap: {
      outcome: 'follow_up',
      summary: '🟡 Left the migration script unrun',
      completedAt: NOW - 45 * 60 * 1000,
    },
  },
}

export const BRIEFS: Record<string, SessionBrief> = {
  '%40': {
    paneId: '%40',
    sessionId: '$4',
    sessionName: 'island',
    state: 'done',
    headline: '🟢 Visor shortcut works on non-notch Macs',
    headlineSource: 'hook',
    recapMarkdown: '- Fixed the notch probe\n- Added a regression test',
    updates: [],
    updatedAt: NOW - 2 * 60 * 60 * 1000,
  },
}

export const USAGE: ProviderUsage[] = [
  {
    provider: 'claude',
    state: 'available',
    plan: 'max',
    windows: [{ label: '5h window', usedPercent: 42, remainingPercent: 58, resetsAt: NOW + 90 * 60 * 1000 }],
    updatedAt: NOW,
  },
  {
    provider: 'codex',
    state: 'available',
    plan: 'pro',
    windows: [{ label: 'weekly', usedPercent: 9, remainingPercent: 91 }],
    updatedAt: NOW,
  },
  {
    provider: 'claude',
    state: 'unavailable',
    windows: [],
    updatedAt: NOW,
    message: 'No usage endpoint on this plan',
  },
]

export const SNAPSHOT_MESSAGE: ServerMessage = { type: 'snapshot', snapshot: SNAPSHOT }

export const STATUS_SNAPSHOT_MESSAGE: ServerMessage = {
  type: 'agent_status_snapshot',
  statuses: [NEEDS_INPUT_STATUS, WORKING_STATUS, CHECKING_STATUS, DONE_STATUS],
}

/**
 * The worklog behind mockup 05: a plan with a cancelled task (which the
 * progress bar must ignore), an out-of-order activity timeline, and a
 * screenshot folder.
 */
export const WORKLOG_BRIEF: SessionBrief = {
  paneId: '%14',
  sessionId: '$1',
  sessionName: 'commando',
  state: 'needs_input',
  headline: 'Add an owner-auth answer channel for the companion',
  headlineSource: 'hook',
  recapMarkdown: [
    'Reusing `buildCompanionSnapshot` keeps **one** snapshot shape for Island and mobile.',
    '',
    '- Broker counts /ws consumers',
    '- ![diagram](shot.png) dropped by the renderer',
  ].join('\n'),
  next: 'Wire answer_agent_request on /ws',
  tasks: [
    { id: 't1', content: 'Read companion hub and broker', status: 'completed', priority: 'high' },
    { id: 't2', content: 'Add ClientMessage answer_agent_request', status: 'completed', priority: 'high' },
    { id: 't3', content: 'Broker: count /ws consumers', status: 'completed', priority: 'medium' },
    { id: 't4', content: 'Unit tests for parse + idempotency', status: 'completed', priority: 'medium' },
    { id: 't5', content: 'Decide auth flow with Leo', status: 'in_progress', priority: 'high' },
    { id: 't6', content: 'Expose provider usage to owner clients', status: 'pending', priority: 'low' },
    { id: 't7', content: 'Push registration route', status: 'pending', priority: 'low' },
    { id: 't8', content: 'Rewrite the tile proxy', status: 'cancelled', priority: 'low' },
  ],
  screenshots: [
    {
      id: '00112233445566aa',
      dir: '/Users/leo/code/commando/.shots/answer-channel',
      topic: 'answer-channel',
      imageCount: 2,
      otherCount: 0,
      bytes: 204_800,
      updatedAt: NOW - 8 * 60 * 1000,
      preview: [
        { name: 'sheet.png', size: 102_400, modifiedAt: NOW - 9 * 60 * 1000 },
        { name: 'strip.png', size: 102_400, modifiedAt: NOW - 8 * 60 * 1000 },
      ],
    },
  ],
  updates: [
    {
      id: 'u2',
      paneId: '%14',
      kind: 'decision',
      text: 'Keep the hook token separate from owner sessions',
      source: 'agent',
      createdAt: NOW - 15 * 60 * 1000,
    },
    {
      id: 'u1',
      paneId: '%14',
      kind: 'check',
      text: 'vitest · 41 passed',
      detail: 'server/companion.test.ts',
      source: 'hook',
      createdAt: NOW - 3 * 60 * 1000,
    },
    {
      id: 'u3',
      paneId: '%14',
      kind: 'blocker',
      text: '/companion/ws rejects non-loopback peers',
      source: 'agent',
      createdAt: NOW - 40 * 60 * 1000,
    },
  ],
  updatedAt: NOW - 3 * 60 * 1000,
}

/** `GET /api/git/summary` for the same pane. */
export const GIT_SUMMARY = {
  isRepo: true,
  root: '/Users/leo/code/commando',
  branch: 'feat/companion-app',
  target: 'origin/main',
  targetMode: 'auto' as const,
  additions: 212,
  deletions: 48,
  files: [
    { path: 'shared/protocol.ts', status: 'M', additions: 24, deletions: 2, binary: false },
    { path: 'server/companion.ts', status: 'M', additions: 84, deletions: 12, binary: false },
    { path: 'server/agent-interaction-broker.ts', status: 'M', additions: 31, deletions: 9, binary: false },
    { path: 'server/companion.test.ts', status: 'M', additions: 73, deletions: 25, binary: false },
  ],
}

/** `GET /api/prs/pane` for the same pane. */
export const PANE_PRS = {
  targetId: '%14',
  totalCount: 1,
  truncated: false,
  fetchedAt: NOW,
  pullRequests: [
    {
      repo: 'leo/commando',
      number: 142,
      title: 'feat: owner-auth companion channel',
      url: 'https://github.com/leo/commando/pull/142',
      state: 'open' as const,
      isDraft: false,
      createdAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(NOW - 20 * 60 * 1000).toISOString(),
    },
  ],
}
