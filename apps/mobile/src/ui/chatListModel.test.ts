import { deriveSessionIdentity } from '@commando/session-identity'
import { EMPTY_HOST_STATE } from '../daemon/state'
import { SNAPSHOT, NEEDS_INPUT_STATUS, WORKING_STATUS, DONE_STATUS } from '../testing/fixtures'
import { buildChatGroups, paneAttention, sessionIndicator } from './chatListModel'

const state = { ...EMPTY_HOST_STATE, snapshot: SNAPSHOT, agentStatuses: { '%14': NEEDS_INPUT_STATUS, '%20': WORKING_STATUS } }
it('groups by repo, resolves identities, and opens the only agent rather than a shell', () => {
  const groups = buildChatGroups(state)
  const commando = groups.find((group) => group.name === 'commando')!.sessions[0]!
  expect(commando.agents.map((pane) => pane.id)).toEqual(['%14'])
  expect(commando.openPaneId).toBe('%14')
  expect(commando.identity).toEqual(deriveSessionIdentity('commando'))
  const saved = deriveSessionIdentity('test')
  expect(buildChatGroups(state, {}, { commando: saved })[0]!.sessions[0]!.identity).toEqual(saved)
})
it('shows multiple agents as children with no implicit destination', () => {
  const groups = buildChatGroups({ ...state, agentStatuses: { ...state.agentStatuses, '%15': { ...WORKING_STATUS, paneId: '%15' } } })
  const row = groups.find((group) => group.name === 'commando')!.sessions[0]!
  expect(row.agents).toHaveLength(2)
  expect(row.openPaneId).toBeUndefined()
})
it('matches desktop attention semantics and ranking including marks', () => {
  const panes = SNAPSHOT.panes.slice(0, 2)
  const working = { ...WORKING_STATUS, paneId: '%15' }
  const review = { ...DONE_STATUS, settledAt: 200, details: undefined }
  expect(paneAttention(review, 100)).toBe('review')
  expect(paneAttention(review, 300)).toBe('idle')
  expect(paneAttention({ ...review, details: { recentActivities: [], checks: [], recap: { outcome: 'done', declared: true, summary: '', completedAt: 200 } } })).toBe('finished')
  expect(sessionIndicator(panes, { '%14': NEEDS_INPUT_STATUS, '%15': working }, {})?.attention).toBe('needs_input')
  expect(sessionIndicator(panes, { '%14': review, '%15': working }, {})?.attention).toBe('review')
  const mark = { targetId: '%14', label: 'Follow up', tone: 'amber' as const, markedAt: 1, activityCount: 1 }
  expect(sessionIndicator(panes, { '%15': working }, { '%14': mark })?.mark).toBe(mark)
})
it('moves auxiliary worktree sessions into Background at the bottom', () => {
  const snapshot = { ...SNAPSHOT, sessions: SNAPSHOT.sessions.map((s) => s.id === '$2' ? { ...s, name: 'native_app-lavish' } : s), panes: SNAPSHOT.panes.map((p) => p.sessionId === '$2' ? { ...p, repo: { ...p.repo!, worktreeRoot: p.path } } : p) }
  const groups = buildChatGroups({ ...state, snapshot })
  expect(groups.at(-1)?.name).toBe('Background')
  expect(groups.at(-1)?.sessions[0]?.session.name).toBe('native_app-lavish')
})
it('matches desktop repo ownership when the first pane differs from the majority', () => {
  const first = SNAPSHOT.panes[0]!
  const second = SNAPSHOT.panes[1]!
  const snapshot = { ...SNAPSHOT, panes: [first, { ...second, repo: { ...second.repo!, root: '/other', name: 'other' } }, { ...second, id: '%extra', repo: { ...second.repo!, root: '/other', name: 'other' } }, ...SNAPSHOT.panes.slice(2)] }
  const groups = buildChatGroups({ ...state, snapshot })
  expect(groups.find((group) => group.name === 'commando')?.sessions[0]?.session.id).toBe('$1')
})
it('derives native chat states even before agent hooks have supplied a status', () => {
  const { chatState, session } = require('../chat/testing') as typeof import('../chat/testing')
  const chat = chatState({ paneId: '%14', session: session({ paneId: '%14', provider: 'codex', status: 'running', title: 'Native chat progress' }) })
  const groups = buildChatGroups({ ...EMPTY_HOST_STATE, snapshot: SNAPSHOT }, { '%14': chat })
  const row = groups.find((group) => group.name === 'commando')!.sessions[0]!
  expect(row.indicator?.attention).toBe('working')
  expect(row.provider).toBe('codex')
  expect(row.subtitle).toBe('Native chat progress')
  expect(row.openPaneId).toBe('%14')
})
