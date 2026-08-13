import { describe, expect, it } from 'vitest'
import type { AgentStatus, AgentStatusKind } from '../shared/protocol.js'
import { AgentStatusRegistry } from './agent-status-registry.js'

const paneId = '%1'
const claudeSessionId = 'claude-session-1'
const openCodeSessionId = 'ses_opencode_1'

function claudePayload(
  hook_event_name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { hook_event_name, session_id: claudeSessionId, ...extra }
}

function openCodeEvent(
  type: string,
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, properties: { sessionID: openCodeSessionId, ...properties } }
}

function inferred(
  overrides: Partial<AgentStatus> = {},
): AgentStatus {
  return {
    paneId,
    provider: 'claude',
    status: 'working',
    summary: 'Claude is producing output',
    source: 'process',
    confidence: 'low',
    reason: 'pane output changed',
    updatedAt: 1,
    ...overrides,
  }
}

describe('AgentStatusRegistry', () => {
  it('maps Claude lifecycle hooks to authoritative statuses', () => {
    const cases: Array<{
      payload: Record<string, unknown>
      status: AgentStatusKind
      confidence?: AgentStatus['confidence']
    }> = [
      { payload: claudePayload('SessionStart'), status: 'unknown', confidence: 'low' },
      { payload: claudePayload('UserPromptSubmit'), status: 'working' },
      { payload: claudePayload('PermissionRequest'), status: 'needs_input' },
      { payload: claudePayload('PostToolUse'), status: 'working' },
      { payload: claudePayload('PostToolUseFailure'), status: 'working' },
      { payload: claudePayload('PermissionDenied'), status: 'working' },
      { payload: claudePayload('ElicitationResult'), status: 'working' },
      { payload: claudePayload('PreToolUse', { tool_name: 'Read' }), status: 'working' },
      {
        payload: claudePayload('PreToolUse', { tool_name: 'AskUserQuestion' }),
        status: 'needs_input',
      },
      {
        payload: claudePayload('PreToolUse', { tool_name: 'PermissionRequest' }),
        status: 'needs_input',
      },
      {
        payload: claudePayload('Notification', { notification_type: 'permission_prompt' }),
        status: 'needs_input',
      },
      {
        payload: claudePayload('Notification', { notification_type: 'elicitation_dialog' }),
        status: 'needs_input',
      },
      {
        payload: claudePayload('Notification', { notification_type: 'agent_needs_input' }),
        status: 'needs_input',
      },
      {
        payload: claudePayload('Notification', { notification_type: 'idle_prompt' }),
        status: 'done',
      },
      {
        payload: claudePayload('Notification', { notification_type: 'elicitation_response' }),
        status: 'working',
      },
      { payload: claudePayload('Stop'), status: 'done' },
      { payload: claudePayload('StopFailure'), status: 'failed' },
    ]

    for (const [index, testCase] of cases.entries()) {
      const registry = new AgentStatusRegistry()
      expect(registry.applyClaudeHook(paneId, testCase.payload, index + 1)).toMatchObject({
        type: 'upsert',
        status: {
          paneId,
          provider: 'claude',
          status: testCase.status,
          source: 'hook',
          confidence: testCase.confidence ?? 'high',
        },
      })
    }
  })

  it('ignores unsupported or malformed Claude hook payloads', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyClaudeHook(paneId, claudePayload('Notification', {
      notification_type: 'transcript_path',
    }))).toBeNull()
    expect(registry.applyClaudeHook(paneId, { hook_event_name: 'Stop' })).toBeNull()
    expect(registry.values()).toEqual([])
  })

  it('removes only the matching Claude provider session on SessionEnd', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('Notification', {
      notification_type: 'idle_prompt',
    }))

    expect(registry.applyClaudeHook(paneId, {
      hook_event_name: 'SessionEnd',
      session_id: 'older-session',
    })).toBeNull()
    expect(registry.get(paneId)?.status).toBe('done')
    expect(registry.applyClaudeHook(paneId, claudePayload('SessionEnd'))).toEqual({
      type: 'remove',
      paneId,
    })
    expect(registry.get(paneId)).toBeUndefined()
    expect(registry.applyInferred(inferred())).toBeNull()
    expect(registry.applyInferred(inferred({ provider: 'codex' }))).toMatchObject({
      type: 'upsert',
      status: { provider: 'codex' },
    })
  })

  it('starts a fresh Claude turn and clears all prior turn details', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'prompt-1',
      intent: 'Implement the first change',
    }), 1)
    registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activity: { label: 'Editing app.ts', kind: 'edit', state: 'running' },
      filePath: 'src/app.ts',
      check: { label: 'typecheck', status: 'running' },
    }), 2)
    registry.applyClaudeHook(paneId, claudePayload('TaskCreated', {
      task: { id: 'task-1', subject: 'Implement app', state: 'created' },
    }), 3)
    registry.applyClaudeHook(paneId, claudePayload('PermissionRequest', {
      attention: 'Approve the command',
    }), 4)
    registry.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: 'First turn finished',
    }), 5)

    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'prompt-2',
      intent: 'Implement the second change',
    }), 6)

    expect(registry.get(paneId)).toMatchObject({
      status: 'working',
      details: {
        intent: 'Implement the second change',
        recentActivities: [],
        checks: [],
      },
    })
    expect(registry.get(paneId)?.details).not.toHaveProperty('currentActivity')
    expect(registry.get(paneId)?.details).not.toHaveProperty('progress')
    expect(registry.get(paneId)?.details).not.toHaveProperty('changes')
    expect(registry.get(paneId)?.details).not.toHaveProperty('attention')
    expect(registry.get(paneId)?.details).not.toHaveProperty('recap')
  })

  it('starts a fresh OpenCode turn and clears the previous turn accumulators', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.turn.started', {
      intent: 'First intent',
    }), 1)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activity: { label: 'Editing app.ts', kind: 'edit', state: 'running' },
      filePath: 'src/app.ts',
      check: { label: 'tests', status: 'running' },
    }), 2)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('todo.updated', {
      todos: [{ content: 'Implement app', status: 'in_progress', priority: 'high' }],
    }), 3)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.idle', {
      finalMessage: 'First turn complete',
    }), 4)

    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.turn.started', {
      intent: 'Second intent',
    }), 5)

    expect(registry.get(paneId)?.details).toEqual({
      intent: 'Second intent',
      recentActivities: [],
      checks: [],
    })
  })

  it('starts a fresh Claude turn when an older provider repeats the same prompt without an id', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      intent: 'Repeat this task',
    }), 1)
    registry.applyClaudeHook(paneId, claudePayload('TaskCreated', {
      task: { id: 'old', subject: 'Old task', state: 'created' },
    }), 2)
    registry.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: 'Old recap',
    }), 3)

    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      intent: 'Repeat this task',
    }), 4)

    expect(registry.get(paneId)?.details).toEqual({
      intent: 'Repeat this task',
      recentActivities: [],
      checks: [],
    })
  })

  it('preserves active Claude turn details across compaction SessionStart hooks', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      intent: 'Keep this turn',
    }), 1)
    registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activityId: 'tool-1',
      activity: { label: 'Editing app.ts', kind: 'edit', state: 'running' },
    }), 2)

    expect(registry.applyClaudeHook(paneId, claudePayload('SessionStart', {
      source: 'compact',
    }), 3)).toBeNull()
    expect(registry.get(paneId)).toMatchObject({
      status: 'working',
      updatedAt: 2,
      details: {
        intent: 'Keep this turn',
        currentActivity: { label: 'Editing app.ts' },
      },
    })
  })

  it('tracks current activity and keeps the three newest completed or failed activities', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'prompt-1',
      intent: 'Inspect and edit',
    }), 1)

    const finish = (
      index: number,
      label: string,
      failed = false,
    ) => {
      registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
        activity: { label, kind: 'edit', state: 'completed', updatedAt: -1 },
      }), index * 2)
      expect(registry.get(paneId)?.details?.currentActivity).toEqual({
        label,
        kind: 'edit',
        state: 'running',
        updatedAt: index * 2,
      })
      registry.applyClaudeHook(paneId, claudePayload(
        failed ? 'PostToolUseFailure' : 'PostToolUse',
        { activity: { label, kind: 'edit', state: failed ? 'failed' : 'completed' } },
      ), index * 2 + 1)
    }

    finish(1, 'First')
    finish(2, 'Second', true)
    finish(3, 'Third')
    finish(4, 'Fourth')

    expect(registry.get(paneId)?.details?.currentActivity).toBeUndefined()
    expect(registry.get(paneId)?.details?.recentActivities).toEqual([
      { label: 'Fourth', kind: 'edit', state: 'completed', updatedAt: 9 },
      { label: 'Third', kind: 'edit', state: 'completed', updatedAt: 7 },
      { label: 'Second', kind: 'edit', state: 'failed', updatedAt: 5 },
    ])
  })

  it('keeps another parallel activity current when one tool completes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activityId: 'tool-a',
      activity: { label: 'Reading config', kind: 'inspect', state: 'running' },
    }), 1)
    registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activityId: 'tool-b',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
    }), 2)
    registry.applyClaudeHook(paneId, claudePayload('PostToolUse', {
      activityId: 'tool-a',
      activity: { label: 'Reading config', kind: 'inspect', state: 'completed' },
    }), 3)

    expect(registry.get(paneId)?.details).toMatchObject({
      currentActivity: { label: 'Running tests', state: 'running' },
      recentActivities: [{ label: 'Reading config', state: 'completed' }],
    })
  })

  it('bounds unmatched parallel activities', () => {
    const registry = new AgentStatusRegistry()
    for (let index = 0; index < 22; index += 1) {
      registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
        activityId: `tool-${index}`,
        activity: { label: `Tool ${index}`, kind: 'other', state: 'running' },
      }), index + 1)
    }
    for (let index = 2; index < 22; index += 1) {
      registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.completed', {
        activityId: `tool-${index}`,
        activity: { label: `Tool ${index}`, kind: 'other', state: 'completed' },
      }), index + 30)
    }

    expect(registry.get(paneId)?.details?.currentActivity).toBeUndefined()
  })

  it('tracks Claude subagent work as delegated activity', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('SubagentStart', {
      activity: { label: 'Subagent Explore', kind: 'delegate', state: 'running' },
    }), 1)
    expect(registry.get(paneId)?.details?.currentActivity).toMatchObject({
      label: 'Subagent Explore',
      kind: 'delegate',
      state: 'running',
    })

    registry.applyClaudeHook(paneId, claudePayload('SubagentStop', {
      activity: { label: 'Subagent Explore', kind: 'delegate', state: 'completed' },
    }), 2)
    expect(registry.get(paneId)?.details?.recentActivities[0]).toEqual({
      label: 'Subagent Explore',
      kind: 'delegate',
      state: 'completed',
      updatedAt: 2,
    })
  })

  it('accumulates Claude tasks and replaces progress from bounded OpenCode todos', () => {
    const claude = new AgentStatusRegistry()
    claude.applyClaudeHook(paneId, claudePayload('TaskCreated', {
      task: { id: 'one', subject: 'First task', state: 'created' },
    }))
    claude.applyClaudeHook(paneId, claudePayload('TaskCreated', {
      task: { id: 'two', subject: 'Second task', state: 'created' },
    }))
    claude.applyClaudeHook(paneId, claudePayload('TaskCompleted', {
      task: { id: 'one', subject: 'First task', state: 'completed' },
    }))
    expect(claude.get(paneId)?.details?.progress).toEqual({
      completed: 1,
      total: 2,
      active: 'Second task',
    })
    expect(claude.get(paneId)?.details?.tasks).toEqual([
      {
        id: 'one',
        content: 'First task',
        status: 'completed',
        priority: 'medium',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
      {
        id: 'two',
        content: 'Second task',
        status: 'pending',
        priority: 'medium',
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      },
    ])

    const openCode = new AgentStatusRegistry()
    openCode.applyOpenCodeEvent(paneId, openCodeEvent('todo.updated', {
      todos: [
        { content: 'Done', status: 'completed', priority: 'high' },
        { content: 'In flight', status: 'in_progress', priority: 'medium' },
        ...Array.from({ length: 25 }, (_, index) => ({
          content: `Pending ${index}`,
          status: 'pending',
          priority: 'low',
        })),
      ],
    }))
    expect(openCode.get(paneId)?.details?.progress).toEqual({
      completed: 1,
      total: 20,
      active: 'In flight',
    })
    expect(openCode.get(paneId)?.details?.tasks?.slice(0, 2)).toEqual([
      expect.objectContaining({ content: 'Done', status: 'completed', priority: 'high' }),
      expect.objectContaining({ content: 'In flight', status: 'in_progress', priority: 'medium' }),
    ])
  })

  it('excludes cancelled OpenCode todos from unfinished progress', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('todo.updated', {
      todos: [
        { content: 'Done', status: 'completed', priority: 'high' },
        { content: 'No longer needed', status: 'cancelled', priority: 'low' },
      ],
    }))

    expect(registry.get(paneId)?.details?.progress).toEqual({ completed: 1, total: 1 })
    expect(registry.get(paneId)?.details?.tasks).toEqual([
      expect.objectContaining({ content: 'Done', status: 'completed' }),
      expect.objectContaining({ content: 'No longer needed', status: 'cancelled' }),
    ])
  })

  it('keeps OpenCode todo order and stable generated ids across status changes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('todo.updated', {
      todos: [
        { content: 'First', status: 'pending', priority: 'high' },
        { content: 'Second', status: 'in_progress', priority: 'low' },
      ],
    }), 10)
    const initial = registry.get(paneId)?.details?.tasks ?? []

    registry.applyOpenCodeEvent(paneId, openCodeEvent('todo.updated', {
      todos: [
        { content: 'First', status: 'completed', priority: 'high' },
        { content: 'Second', status: 'in_progress', priority: 'low' },
      ],
    }), 20)
    const updated = registry.get(paneId)?.details?.tasks ?? []

    expect(updated.map((task) => task.content)).toEqual(['First', 'Second'])
    expect(updated.map((task) => task.id)).toEqual(initial.map((task) => task.id))
    expect(updated[0]).toMatchObject({ createdAt: 10, updatedAt: 20, status: 'completed' })
    expect(updated[1]).toMatchObject({ createdAt: 10, updatedAt: 10, status: 'in_progress' })
  })

  it('bounds unique changed files, merges diffs, and keeps four checks by label', () => {
    const registry = new AgentStatusRegistry()
    for (let index = 0; index < 22; index += 1) {
      registry.applyOpenCodeEvent(paneId, openCodeEvent('file.edited', {
        filePath: `old/file-${index}.ts`,
      }), index + 1)
    }
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.diff', {
      diff: Array.from({ length: 25 }, (_, index) => ({
        file: `src/file-${index}.ts`,
        additions: index,
        deletions: 1,
      })),
    }), 30)

    for (let index = 0; index < 5; index += 1) {
      registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
        activity: { label: `Check ${index}`, kind: 'check', state: 'running' },
        check: { label: `check-${index}`, status: 'running' },
      }), 40 + index)
    }
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.completed', {
      activity: { label: 'Check 4', kind: 'check', state: 'completed' },
      check: { label: 'check-4', status: 'passed' },
    }), 50)

    expect(registry.get(paneId)?.details?.changes).toEqual({
      fileCount: 20,
      additions: 190,
      deletions: 20,
    })
    expect(JSON.stringify(registry.get(paneId))).not.toContain('src/file-')
    expect(JSON.stringify(registry.get(paneId))).not.toContain('old/file-')
    expect(registry.get(paneId)?.details?.checks).toEqual([
      { label: 'check-4', status: 'passed', updatedAt: 50 },
      { label: 'check-3', status: 'running', updatedAt: 43 },
      { label: 'check-2', status: 'running', updatedAt: 42 },
      { label: 'check-1', status: 'running', updatedAt: 41 },
    ])
  })

  it('keeps a check running until all same-label parallel checks complete', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activityId: 'tests-a',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 1)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activityId: 'tests-b',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 2)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.completed', {
      activityId: 'tests-a',
      activity: { label: 'Running tests', kind: 'check', state: 'completed' },
      check: { label: 'tests', status: 'passed' },
    }), 3)

    expect(registry.get(paneId)?.details?.checks[0]).toEqual({
      label: 'tests',
      status: 'running',
      updatedAt: 2,
    })
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.completed', {
      activityId: 'tests-b',
      activity: { label: 'Running tests', kind: 'check', state: 'failed' },
      check: { label: 'tests', status: 'failed' },
    }), 4)
    expect(registry.get(paneId)?.details?.checks[0]).toEqual({
      label: 'tests',
      status: 'failed',
      updatedAt: 4,
    })
  })

  it('removes unresolved running checks from terminal provider states', () => {
    const claude = new AgentStatusRegistry()
    claude.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activityId: 'claude-tests',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 1)
    claude.applyClaudeHook(paneId, claudePayload('Stop'), 2)
    expect(claude.get(paneId)?.details?.checks).toEqual([])

    const idle = new AgentStatusRegistry()
    idle.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activityId: 'idle-tests',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 3)
    idle.applyOpenCodeEvent(paneId, openCodeEvent('session.idle'), 4)
    expect(idle.get(paneId)?.details?.checks).toEqual([])

    const failed = new AgentStatusRegistry()
    failed.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activityId: 'failed-tests',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 5)
    failed.applyOpenCodeEvent(paneId, openCodeEvent('session.error', { error: 'Stopped' }), 6)
    expect(failed.get(paneId)?.details?.checks).toEqual([])
  })

  it('retains attention until all requests clear and clears it after successful work', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'permission-1',
      attention: 'Approve command',
    }))
    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-1',
      attention: 'Choose target',
    }))
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.replied', {
      requestID: 'permission-1',
    }))
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.completed', {
      activity: { label: 'Read config', kind: 'inspect', state: 'completed' },
    }))
    expect(registry.get(paneId)).toMatchObject({
      status: 'needs_input',
      details: { attention: 'Choose target' },
    })

    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.replied', {
      requestID: 'question-1',
    }))
    expect(registry.get(paneId)?.details?.attention).toBeUndefined()

    registry.applyClaudeHook(paneId, claudePayload('PermissionRequest', {
      attention: 'Approve Claude command',
    }))
    registry.applyClaudeHook(paneId, claudePayload('PostToolUse', {
      activity: { label: 'Ran command', kind: 'command', state: 'completed' },
    }))
    expect(registry.get(paneId)?.details?.attention).toBeUndefined()
  })

  it('restores the latest unanswered prompt when a newer request is answered first', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'permission-1',
      attention: 'Approve command',
    }), 1)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-1',
      attention: 'Choose target',
    }), 2)

    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.replied', {
      requestID: 'question-1',
    }), 3)

    expect(registry.get(paneId)).toMatchObject({
      status: 'needs_input',
      details: { attention: 'Approve command' },
    })
  })

  it('preserves cross-type request arrival order when timestamps match', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-old',
      attention: 'Older question',
    }), 1)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'permission-newer',
      attention: 'Newer permission',
    }), 1)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-latest',
      attention: 'Latest question',
    }), 2)

    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.replied', {
      requestID: 'question-latest',
    }), 3)

    expect(registry.get(paneId)?.details?.attention).toBe('Newer permission')
  })

  it.each([
    ['🟢', 'done'],
    ['🟡', 'follow_up'],
    ['🔴', 'blocked'],
  ] as const)('parses an explicit %s Builder recap', (marker, outcome) => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: `Earlier detail\n${marker} Concise outcome`,
      backgroundTasks: 2,
    }), 42)

    expect(registry.get(paneId)?.details?.recap).toEqual({
      outcome,
      summary: 'Concise outcome',
      completedAt: 42,
    })
    expect(registry.get(paneId)?.status).toBe(outcome === 'blocked' ? 'needs_input' : 'done')
  })

  it('uses the first useful final line and deterministic recap fallbacks', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: '\n  First useful line  \nMore detail',
    }), 10)
    expect(registry.get(paneId)?.details?.recap).toEqual({
      outcome: 'done',
      summary: 'First useful line',
      completedAt: 10,
    })

    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'next',
      intent: 'Another turn',
    }), 11)
    registry.applyClaudeHook(paneId, claudePayload('Stop'), 12)
    expect(registry.get(paneId)?.details?.recap).toEqual({
      outcome: 'done',
      summary: 'Claude completed the turn',
      completedAt: 12,
    })
  })

  it('prioritizes pending attention and incomplete work in recap outcomes', () => {
    const blocked = new AgentStatusRegistry()
    blocked.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-1',
      attention: 'Choose a deployment target',
    }), 1)
    blocked.applyOpenCodeEvent(paneId, openCodeEvent('session.idle', {
      finalMessage: '🟢 Otherwise done',
    }), 2)
    expect(blocked.get(paneId)?.details?.recap).toMatchObject({
      outcome: 'blocked',
      summary: 'Choose a deployment target',
    })
    expect(blocked.get(paneId)?.status).toBe('needs_input')

    const followUp = new AgentStatusRegistry()
    followUp.applyClaudeHook(paneId, claudePayload('TaskCreated', {
      task: { id: 'task-1', subject: 'Background task', state: 'created' },
    }), 3)
    followUp.applyClaudeHook(paneId, claudePayload('Stop', {
      backgroundTasks: 1,
    }), 4)
    expect(followUp.get(paneId)?.details?.recap).toEqual({
      outcome: 'follow_up',
      summary: 'Claude has follow-up work',
      completedAt: 4,
    })
  })

  it('prioritizes bounded failed recaps for Claude and OpenCode errors', () => {
    const claude = new AgentStatusRegistry()
    claude.applyClaudeHook(paneId, claudePayload('StopFailure', {
      error: `Failure ${'x'.repeat(300)}`,
      finalMessage: 'Ignored final text',
    }), 20)
    expect(claude.get(paneId)).toMatchObject({
      status: 'failed',
      details: { recap: { outcome: 'failed', completedAt: 20 } },
    })
    expect(claude.get(paneId)?.details?.recap?.summary).toHaveLength(180)

    const openCode = new AgentStatusRegistry()
    openCode.applyOpenCodeEvent(paneId, openCodeEvent('session.error', {
      error: 'Provider failed',
    }), 21)
    expect(openCode.get(paneId)).toMatchObject({
      status: 'failed',
      details: {
        recap: { outcome: 'failed', summary: 'Provider failed', completedAt: 21 },
      },
    })
  })

  it('retains completed recaps through Claude SessionEnd and process exit', () => {
    const claude = new AgentStatusRegistry()
    claude.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: 'Claude finished',
    }), 1, 'claude')
    expect(claude.applyClaudeHook(paneId, claudePayload('SessionEnd'), 2, 'zsh')).toBeNull()
    expect(claude.get(paneId)).toMatchObject({
      provider: 'claude',
      status: 'done',
      details: { recap: { summary: 'Claude finished' } },
    })
    expect(claude.applyInferred(inferred({ provider: 'claude' }))).toBeNull()

    const openCode = new AgentStatusRegistry()
    openCode.applyOpenCodeEvent(paneId, openCodeEvent('session.idle', {
      finalMessage: 'OpenCode finished',
    }), 3, 'opencode')
    expect(openCode.removeIfProcessChanged(paneId, 'zsh')).toBeNull()
    expect(openCode.get(paneId)).toMatchObject({
      provider: 'opencode',
      status: 'done',
      details: { recap: { summary: 'OpenCode finished' } },
    })
    expect(openCode.applyInferred(inferred({ provider: 'opencode' }))).toBeNull()
  })

  it('retains blocked recaps through Claude SessionEnd and process exit', () => {
    const claude = new AgentStatusRegistry()
    claude.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: '🔴 Approve the release',
    }), 1, 'claude')
    expect(claude.applyClaudeHook(paneId, claudePayload('SessionEnd'), 2, 'zsh')).toBeNull()
    expect(claude.get(paneId)).toMatchObject({
      status: 'needs_input',
      details: { recap: { outcome: 'blocked', summary: 'Approve the release' } },
    })

    const openCode = new AgentStatusRegistry()
    openCode.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-1',
      attention: 'Choose a target',
    }), 3, 'opencode')
    openCode.applyOpenCodeEvent(paneId, openCodeEvent('session.idle'), 4, 'opencode')
    expect(openCode.removeIfProcessChanged(paneId, 'zsh')).toBeNull()
    expect(openCode.get(paneId)).toMatchObject({
      status: 'needs_input',
      details: { recap: { outcome: 'blocked', summary: 'Choose a target' } },
    })
  })

  it('replaces a retained completion with a fresh provider turn', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('Stop', {
      finalMessage: 'Old recap',
    }), 1, 'claude')
    registry.applyClaudeHook(paneId, claudePayload('SessionEnd'), 2, 'zsh')

    expect(registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'fresh',
      intent: 'Fresh work',
    }), 3, 'zsh')).toMatchObject({
      type: 'upsert',
      status: { status: 'working', details: { intent: 'Fresh work' } },
    })
    expect(registry.get(paneId)?.details?.recap).toBeUndefined()
  })

  it('deeply clones details and strips details from inferred statuses', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('UserPromptSubmit', {
      prompt_id: 'prompt-1',
      intent: 'Immutable intent',
    }), 1)
    registry.applyClaudeHook(paneId, claudePayload('PreToolUse', {
      activity: { label: 'Editing file', kind: 'edit', state: 'running' },
      filePath: 'src/file.ts',
      check: { label: 'tests', status: 'running' },
    }), 2)

    const fromGet = registry.get(paneId)
    if (!fromGet?.details?.currentActivity || !fromGet.details.changes) {
      throw new Error('Expected populated details')
    }
    fromGet.details.intent = 'Mutated intent'
    fromGet.details.currentActivity.label = 'Mutated activity'
    fromGet.details.changes.fileCount = 999
    fromGet.details.checks[0].label = 'mutated check'
    const fromValues = registry.values()[0]
    if (!fromValues.details) throw new Error('Expected details from values')
    fromValues.details.recentActivities.push({
      label: 'Injected',
      kind: 'other',
      state: 'completed',
      updatedAt: 3,
    })

    expect(registry.get(paneId)?.details).toMatchObject({
      intent: 'Immutable intent',
      currentActivity: { label: 'Editing file' },
      changes: { fileCount: 1 },
      checks: [{ label: 'tests' }],
      recentActivities: [],
    })

    const inferredRegistry = new AgentStatusRegistry()
    inferredRegistry.applyInferred(inferred({
      details: { recentActivities: [], checks: [], intent: 'Discard me' },
    }))
    expect(inferredRegistry.get(paneId)).not.toHaveProperty('details')
  })

  it('maps OpenCode status events and treats session.idle as a duplicate idle signal', () => {
    const registry = new AgentStatusRegistry()

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 1)).toMatchObject({ status: { provider: 'opencode', status: 'working' } })
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'retry', attempt: 1 },
    }), 2)).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(1)
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'idle' },
    }), 3)).toMatchObject({ status: { status: 'done' } })
    expect(registry.applyOpenCodeEvent(
      paneId,
      openCodeEvent('session.idle'),
      4,
    )).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(3)
  })

  it('keeps same-session OpenCode failures through idle and recovers on busy', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyOpenCodeEvent(
      paneId,
      openCodeEvent('session.error', { error: { name: 'APIError' } }),
    )).toMatchObject({ status: { status: 'failed' } })

    expect(registry.applyOpenCodeEvent(
      paneId,
      openCodeEvent('session.idle'),
    )).toBeNull()
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'idle' },
    }))).toBeNull()
    expect(registry.get(paneId)?.status).toBe('failed')

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }))).toMatchObject({ status: { status: 'working' } })
  })

  it('tracks permission and question requests until each specific request is answered', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'per_1',
    }))).toMatchObject({ status: { status: 'needs_input' } })
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'que_1',
    }))).toMatchObject({
      status: {
        status: 'needs_input',
        details: { requests: [{ id: 'per_1' }, { id: 'que_1' }] },
      },
    })

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.replied', {
      requestID: 'per_1',
    }))).toMatchObject({
      status: {
        status: 'needs_input',
        details: { requests: [{ id: 'que_1' }] },
      },
    })
    expect(registry.get(paneId)?.status).toBe('needs_input')

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('question.replied', {
      requestID: 'que_1',
    }))).toMatchObject({ status: { status: 'working' } })

    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', { id: 'que_2' }))
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('question.rejected', {
      requestID: 'que_2',
    }))).toMatchObject({ status: { status: 'working' } })
  })

  it('preserves agent session names and resolves companion interaction requests', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('question.asked', {
      id: 'question-1',
      sessionName: 'Choose the deployment',
      attention: 'Which target?',
      request: {
        id: 'question-1',
        kind: 'question',
        prompt: 'Which target?',
        questions: [{
          header: 'Target',
          question: 'Which target?',
          options: [{ label: 'Production', description: 'Deploy now' }],
          multiple: false,
          custom: false,
        }],
      },
    }), 10)

    expect(registry.get(paneId)).toMatchObject({
      agentSessionId: openCodeSessionId,
      agentSessionName: 'Choose the deployment',
      details: {
        requests: [{
          id: 'question-1',
          questions: [{ options: [{ label: 'Production' }] }],
        }],
      },
    })
    expect(registry.resolveInteractionRequest(paneId, 'question-1', 11)).toMatchObject({
      status: {
        status: 'working',
        agentSessionName: 'Choose the deployment',
        updatedAt: 11,
      },
    })
    expect(registry.get(paneId)?.details?.requests).toBeUndefined()

    registry.applyClaudeHook('%2', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session',
      session_title: 'Review auth changes',
    }, 12)
    expect(registry.get('%2')).toMatchObject({
      agentSessionId: 'claude-session',
      agentSessionName: 'Review auth changes',
    })
  })

  it('replaces pending request state when the provider session changes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'per_old',
    }))

    expect(registry.applyOpenCodeEvent(paneId, {
      type: 'question.asked',
      properties: { sessionID: 'ses_opencode_2', id: 'que_new' },
    })).toMatchObject({
      status: {
        agentSessionId: 'ses_opencode_2',
        details: { requests: [{ id: 'que_new' }] },
      },
    })
    expect(registry.applyOpenCodeEvent(paneId, {
      type: 'question.replied',
      properties: { sessionID: 'ses_opencode_2', requestID: 'que_new' },
    })).toMatchObject({ status: { status: 'working' } })
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.replied', {
      requestID: 'per_old',
    }))).toBeNull()
    expect(registry.get(paneId)?.status).toBe('working')
  })

  it('removes only the matching OpenCode session, including session info payloads', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }))

    expect(registry.applyOpenCodeEvent(paneId, {
      type: 'session.deleted',
      properties: { info: { id: 'ses_other' } },
    })).toBeNull()
    expect(registry.applyOpenCodeEvent(paneId, {
      type: 'session.deleted',
      properties: { info: { id: openCodeSessionId } },
    })).toEqual({ type: 'remove', paneId })
  })

  it('does not let inferred state overwrite or remove hook-owned state', () => {
    const registry = new AgentStatusRegistry()
    registry.applyClaudeHook(paneId, claudePayload('Stop'))

    expect(registry.applyInferred(inferred({ status: 'working' }))).toBeNull()
    expect(registry.applyInferred(inferred({
      provider: 'unknown',
      status: 'unknown',
    }))).toBeNull()
    expect(registry.get(paneId)).toMatchObject({
      provider: 'claude',
      status: 'done',
      source: 'hook',
    })
  })

  it('reconciles a hook-owned OpenCode turn when the settled composer shows completion', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.turn.started', {
      intent: 'Finish the HUD fix',
    }), 1_000)
    registry.applyOpenCodeEvent(paneId, openCodeEvent('commando.activity.started', {
      activityId: 'check-1',
      activity: { label: 'Running tests', kind: 'check', state: 'running' },
      check: { label: 'tests', status: 'running' },
    }), 2_000)

    expect(registry.applyInferred(inferred({
      provider: 'opencode',
      status: 'done',
      summary: 'opencode is idle',
      source: 'heuristic',
      confidence: 'high',
      reason: 'OpenCode composer shows no active work',
      updatedAt: 4_000,
    }))).toMatchObject({
      type: 'upsert',
      status: {
        provider: 'opencode',
        status: 'done',
        source: 'hook',
        confidence: 'high',
        updatedAt: 4_000,
        details: {
          intent: 'Finish the HUD fix',
          recentActivities: [],
          checks: [],
          recap: {
            outcome: 'done',
            summary: 'OpenCode completed the turn',
            completedAt: 4_000,
          },
        },
      },
    })
    expect(registry.get(paneId)?.details).not.toHaveProperty('currentActivity')

    expect(registry.applyInferred(inferred({
      provider: 'opencode',
      status: 'done',
      source: 'heuristic',
      confidence: 'high',
      updatedAt: 5_000,
    }))).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(4_000)
  })

  it('does not reconcile hook-owned OpenCode work from a medium-confidence completion marker', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 1)

    expect(registry.applyInferred(inferred({
      provider: 'opencode',
      status: 'done',
      source: 'heuristic',
      confidence: 'medium',
    }))).toBeNull()
    expect(registry.get(paneId)?.status).toBe('working')
  })

  it('retains a confirmed inferred completion until high-confidence work resumes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyInferred(inferred({
      provider: 'opencode',
      status: 'done',
      source: 'heuristic',
      confidence: 'high',
    }))

    expect(registry.applyInferred(inferred({ provider: 'opencode' }))).toBeNull()
    expect(registry.get(paneId)?.status).toBe('done')

    expect(registry.applyInferred(inferred({
      provider: 'opencode',
      status: 'working',
      source: 'heuristic',
      confidence: 'high',
    }))).toMatchObject({ status: { status: 'working' } })
  })

  it('uses unknown inferred state to remove only an inferred record', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyInferred(inferred())).toMatchObject({
      type: 'upsert',
      status: { source: 'process' },
    })
    expect(registry.applyInferred(inferred({ status: 'unknown' }))).toMatchObject({
      type: 'upsert',
      status: { provider: 'claude', status: 'unknown' },
    })
    expect(registry.applyInferred(inferred({
      provider: 'unknown',
      status: 'unknown',
    }))).toEqual({
      type: 'remove',
      paneId,
    })
    expect(registry.applyInferred(inferred({ provider: 'unknown', status: 'unknown' }))).toBeNull()
  })

  it('keeps the transition timestamp for duplicate semantic state', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyInferred(inferred({ updatedAt: 10 }))).not.toBeNull()
    expect(registry.applyInferred(inferred({ updatedAt: 20 }))).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(10)
  })

  it('removes hook state when its pane foreground command changes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 1, 'opencode')

    expect(registry.removeIfProcessChanged(paneId, 'opencode')).toBeNull()
    expect(registry.removeIfProcessChanged(paneId, 'zsh')).toEqual({
      type: 'remove',
      paneId,
    })
    expect(registry.applyInferred(inferred({ provider: 'opencode' }))).toBeNull()
    expect(registry.applyInferred(inferred())).toMatchObject({ type: 'upsert' })
  })

  it('rejects late provider events after its process exits', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 1, 'opencode')
    registry.removeIfProcessChanged(paneId, 'zsh')

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'idle' },
    }), 2, 'zsh')).toBeNull()
    expect(registry.get(paneId)).toBeUndefined()
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 3, 'opencode')).toMatchObject({ status: { status: 'working' } })
  })

  it('supports direct removal and pruning to retained pane ids', () => {
    const registry = new AgentStatusRegistry()
    registry.applyInferred(inferred({ paneId: '%1' }))
    registry.applyInferred(inferred({ paneId: '%2' }))
    registry.applyInferred(inferred({ paneId: '%3' }))

    expect(registry.retainPaneIds(new Set(['%1']))).toEqual([
      { type: 'remove', paneId: '%2' },
      { type: 'remove', paneId: '%3' },
    ])
    expect(registry.values().map((status) => status.paneId)).toEqual(['%1'])
    expect(registry.remove('%1')).toEqual({ type: 'remove', paneId: '%1' })
    expect(registry.remove('%1')).toBeNull()
  })
})
