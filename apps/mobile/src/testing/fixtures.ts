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
