import { describe, expect, it } from 'vitest'
import type { ChatItem, ExternalAgentRun } from './agent-chat.js'
import { deriveTimelineRows, withExternalAgentRuns } from './chat-timeline.js'

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
