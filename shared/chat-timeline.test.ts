import { describe, expect, it } from 'vitest'
import type { ChatItem, ExternalAgentRun } from './agent-chat.js'
import { activitySummary, deriveTimelineRows, mergeActivityRows, withExternalAgentRuns, type ActivityItem } from './chat-timeline.js'

const base = { turnId: 'turn-1', status: 'completed' as const, createdAt: 1_000, updatedAt: 1_000 }
const run = (id: string, startedAt = 2_000): ExternalAgentRun => ({ id, runtime: 'codex', label: 'Review tests', state: 'running', startedAt, updatedAt: startedAt })
const command = (id: string, text: string, createdAt = 1_000, turnId = 'turn-1'): ChatItem => ({ ...base, id, kind: 'command', toolUseId: id, command: text, createdAt, turnId })

describe('external run anchoring', () => {
  it('anchors after the latest matching launch command within the time bound', () => {
    const items = [command('old', 'codex exec old'), command('launch', 'codex exec resume session', 1_500), command('future', 'codex exec future', 20_000, 'turn-2')]
    const result = withExternalAgentRuns(items, [run('external-1')])
    expect(result.map((item) => item.id)).toEqual(['old', 'launch', 'external-1', 'future'])
    expect(result[2]).toMatchObject({ kind: 'subagent', runtime: 'codex', turnId: 'turn-1', toolUseId: 'external-1', status: 'running' })
    expect(items).toHaveLength(3)
  })

  it('groups parallel runs at their launch, keeps quiet live, and excludes scoped subagent commands', () => {
    const items = [command('launch', 'codex exec first & codex exec second &'), { ...command('nested', 'codex exec nested', 1_900), parentToolUseId: 'sdk-agent' }, command('later', 'npm test', 2_500)]
    const result = withExternalAgentRuns(items, [{ ...run('external-2', 2_100), state: 'quiet' }, run('external-1')])
    expect(result.map((item) => item.id)).toEqual(['launch', 'external-1', 'external-2', 'nested', 'later'])
    const rows = deriveTimelineRows(result)
    expect(rows.map((row) => row.kind)).toEqual(['work', 'subagents', 'work'])
    expect(rows[1]).toMatchObject({ live: true, items: [expect.objectContaining({ id: 'external-1' }), expect.objectContaining({ id: 'external-2' })] })
  })

  it('keeps runs from separate Bash calls in one card in their launching turn', () => {
    const items = [command('launch-1', 'codex exec first', 1_000), command('launch-2', 'codex exec second', 20_000)]
    const combined = withExternalAgentRuns(items, [run('external-1'), run('external-2', 21_000)])
    expect(combined.map((item) => item.id)).toEqual(['launch-1', 'external-1', 'launch-2', 'external-2'])
    const groups = deriveTimelineRows(combined).filter((row) => row.kind === 'subagents')
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['external-1', 'external-2'])
  })

  it('falls back to start-time order and retains the launching turn across subsequent turns', () => {
    const items: ChatItem[] = [{ ...base, id: 'u1', kind: 'user_message', text: 'Start the review' }, command('work', 'ls', 3_000), { ...base, id: 'u2', kind: 'user_message', text: 'Next turn', turnId: 'turn-2', createdAt: 4_000 }]
    const result = withExternalAgentRuns(items, [run('external-1')])
    expect(result.map((item) => item.id)).toEqual(['u1', 'external-1', 'work', 'u2'])
    expect(result[1]?.turnId).toBe('turn-1')
  })

  it.each([
    ['claude', '/Users/test/.local/bin/claude --model sonnet -p "Review"'],
    ['opencode', 'opencode run "Review"'],
    ['cursor', 'cursor-agent --print "Review"'],
  ] as const)('anchors %s by its invocation and keeps completed history', (runtime, invocation) => {
    const result = withExternalAgentRuns([command('launch', invocation), command('work', 'ls', 1_100)], [{ ...run('external-1'), runtime, state: 'completed', finishedAt: 5_000 }])
    expect(result[1]).toMatchObject({ id: 'external-1', status: 'completed', updatedAt: 5_000, runtime })
  })

  it('places a run before the first item when its launch predates retained history', () => {
    expect(withExternalAgentRuns([command('later', 'ls', 5_000)], [run('external-1')]).map((item) => item.id)).toEqual(['external-1', 'later'])
  })
})

describe('quiet activity rows', () => {
  const thought = (id: string, createdAt: number, updatedAt: number, status: 'completed' | 'running' = 'completed'): ChatItem => ({ ...base, id, kind: 'reasoning', text: 'Considering', createdAt, updatedAt, status })
  const edit = (id: string, path: string, additions: number, deletions: number): ChatItem => ({ ...base, id, kind: 'file_change', toolUseId: id, toolName: 'Edit', path, additions, deletions })
  const read = (id: string): ChatItem => ({ ...base, id, kind: 'tool', toolUseId: id, toolName: 'Read', title: 'src/a.ts' })
  const user = (id: string, text: string): ChatItem => ({ ...base, id, kind: 'user_message', text })
  const reply = (id: string): ChatItem => ({ ...base, id, kind: 'assistant_message', text: 'Done' })

  it('merges thoughts and tool work between two messages into one row', () => {
    const items = [user('u', 'Fix it'), thought('t1', 1_000, 4_000), read('r'), thought('t2', 5_000, 6_000), command('c', 'npm test', 6_000), reply('a1'), thought('t3', 7_000, 8_000), edit('e', 'a.ts', 1, 0), reply('a2')]
    const rows = mergeActivityRows(deriveTimelineRows(items))
    expect(rows.map((row) => row.kind)).toEqual(['user', 'activity', 'assistant', 'activity', 'assistant'])
    expect(rows[1]).toMatchObject({ id: 'activity-t1', live: false, items: [{ id: 't1' }, { id: 'r' }, { id: 't2' }, { id: 'c' }] })
  })

  it('keeps subagents, plans and notices as their own rows between stretches', () => {
    const items = [read('r1'), { ...base, id: 'n', kind: 'notice', level: 'info', text: 'Compacted' } as ChatItem, read('r2')]
    expect(mergeActivityRows(deriveTimelineRows(items)).map((row) => row.kind)).toEqual(['activity', 'notice', 'activity'])
  })

  it('is live while any merged step runs', () => {
    const rows = mergeActivityRows(deriveTimelineRows([read('r'), thought('t', 2_000, 2_000, 'running')]))
    expect(rows).toMatchObject([{ kind: 'activity', live: true }])
  })

  it('leads with edits and their line counts, counts failures and ignores thinking', () => {
    const items = [thought('t', 1_000, 3_000), edit('e1', 'a.ts', 4, 7), edit('e2', 'b.ts', 3, 1), edit('e3', 'a.ts', 1, 0), { ...command('c1', 'npm test'), isError: true }, { ...command('c2', 'npm test'), updatedAt: 42_000 }, read('r')] as ActivityItem[]
    expect(activitySummary(items)).toEqual({ edits: { label: 'Edited 2 files', additions: 8, deletions: 8 }, rest: 'ran 2 commands, read 1 file', failed: 1, elapsedMs: 41_000 })
  })

  it('capitalises the rest when nothing was edited and names thinking only when it is alone', () => {
    expect(activitySummary([read('r'), command('c', 'ls')] as ActivityItem[])).toMatchObject({ edits: null, rest: 'Ran 1 command, read 1 file', elapsedMs: null })
    expect(activitySummary([thought('t', 1_000, 7_000)] as ActivityItem[])).toMatchObject({ edits: null, rest: 'Thought', elapsedMs: 6_000 })
  })

  it('times a live stretch to now', () => {
    expect(activitySummary([thought('t', 1_000, 2_000, 'running')] as ActivityItem[], 20_000).elapsedMs).toBe(19_000)
  })
})
