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
    registry.applyClaudeHook(paneId, claudePayload('Stop'))

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
  })

  it('maps OpenCode status events and treats session.idle as a duplicate idle signal', () => {
    const registry = new AgentStatusRegistry()

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'busy' },
    }), 1)).toMatchObject({ status: { provider: 'opencode', status: 'working' } })
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'retry', attempt: 1 },
    }), 2)).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(2)
    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('session.status', {
      status: { type: 'idle' },
    }), 3)).toMatchObject({ status: { status: 'done' } })
    expect(registry.applyOpenCodeEvent(
      paneId,
      openCodeEvent('session.idle'),
      4,
    )).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(4)
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
    }))).toBeNull()

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.replied', {
      requestID: 'per_1',
    }))).toBeNull()
    expect(registry.get(paneId)?.status).toBe('needs_input')

    expect(registry.applyOpenCodeEvent(paneId, openCodeEvent('question.replied', {
      requestID: 'que_1',
    }))).toMatchObject({ status: { status: 'working' } })
  })

  it('replaces pending request state when the provider session changes', () => {
    const registry = new AgentStatusRegistry()
    registry.applyOpenCodeEvent(paneId, openCodeEvent('permission.asked', {
      id: 'per_old',
    }))

    expect(registry.applyOpenCodeEvent(paneId, {
      type: 'question.asked',
      properties: { sessionID: 'ses_opencode_2', id: 'que_new' },
    })).toBeNull()
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

  it('returns null for duplicate semantic state while updating its timestamp', () => {
    const registry = new AgentStatusRegistry()
    expect(registry.applyInferred(inferred({ updatedAt: 10 }))).not.toBeNull()
    expect(registry.applyInferred(inferred({ updatedAt: 20 }))).toBeNull()
    expect(registry.get(paneId)?.updatedAt).toBe(20)
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
