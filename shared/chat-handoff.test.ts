import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatSessionInfo } from './agent-chat.js'
import {
  HANDOFF_BRIEF_PREFIX,
  HANDOFF_MARKER_PREFIX,
  MAX_HANDOFF_BRIEF_CHARS,
  availableProviderModels,
  buildHandoffBrief,
  handoffDividerLabel,
  handoffDividerText,
  handoffPermissionMode,
  isHandoffNotice,
  parseHandoffNotice,
  supportsHandoffPermissionMode,
} from './chat-handoff.js'
import type { ModelCatalogs } from './tmux-create.js'

const base = (id: string, parentToolUseId?: string) => ({
  id,
  turnId: `turn-${id}`,
  status: 'completed' as const,
  createdAt: 1,
  updatedAt: 1,
  ...(parentToolUseId ? { parentToolUseId } : {}),
})

const userMsg = (id: string, text: string, parentToolUseId?: string): ChatItem => ({
  ...base(id, parentToolUseId),
  kind: 'user_message',
  text,
})

const assistantMsg = (id: string, text: string, parentToolUseId?: string): ChatItem => ({
  ...base(id, parentToolUseId),
  kind: 'assistant_message',
  text,
})

const planItem = (id: string, text: string, parentToolUseId?: string): ChatItem => ({
  ...base(id, parentToolUseId),
  kind: 'plan',
  toolUseId: `tool-${id}`,
  text,
})

const fileChange = (id: string, path: string, isError = false): ChatItem => ({
  ...base(id),
  kind: 'file_change',
  toolUseId: `tool-${id}`,
  toolName: 'Edit',
  path,
  additions: 3,
  deletions: 1,
  ...(isError ? { isError: true } : {}),
})

const todoList = (id: string, todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[], parentToolUseId?: string): ChatItem => ({
  ...base(id, parentToolUseId),
  kind: 'todo_list',
  todos,
})

const session = (overrides: Partial<ChatSessionInfo>): ChatSessionInfo => ({
  paneId: '%1',
  provider: 'claude',
  cwd: '/work/repo',
  status: 'idle',
  hostPid: 100,
  hostVersion: 8,
  permissionMode: 'default',
  ...overrides,
})

describe('buildHandoffBrief', () => {
  it('builds a structured brief with header, note, recent requests, plan, assistant summary, files, todos, and closing', () => {
    const items: ChatItem[] = [
      userMsg('u1', 'Investigate auth bug'),
      assistantMsg('a1', 'Found token expiry issue.'),
      userMsg('u2', 'Draft a fix plan [Attached image "shot.png" is saved at: /tmp/abc.png]'),
      userMsg('u-sub', 'Subagent prompt should be ignored', 'agent-1'),
      planItem('p1', '# Fix auth\n1. Refresh token\n2. Add tests'),
      fileChange('f1', '/work/repo/src/auth.ts'),
      fileChange('f2', '/work/repo/src/auth.ts'),
      fileChange('f3', '/work/repo/src/auth.test.ts'),
      fileChange('f4', '/work/repo/src/failed.ts', true),
      todoList('td1', [
        { content: 'Old todo', status: 'pending' },
      ]),
      todoList('td2', [
        { content: 'Update token refresh', status: 'completed' },
        { content: 'Add integration test', status: 'in_progress' },
        { content: 'Run full test suite', status: 'pending' },
      ]),
      assistantMsg('a-sub', 'Subagent reply should be ignored', 'agent-1'),
      assistantMsg('a2', 'Implemented token refresh in src/auth.ts; next step is adding the integration test.'),
    ]

    const brief = buildHandoffBrief({
      fromProvider: 'claude',
      toProvider: 'cursor',
      cwd: '/work/repo',
      title: 'Fix auth token refresh',
      items,
      note: 'Focus on edge cases around clock skew.',
    })

    expect(brief).toContain('You are taking over this conversation from Claude in /work/repo.')
    expect(brief).toContain('Conversation: Fix auth token refresh')
    expect(brief).toContain('## Handoff note\nFocus on edge cases around clock skew.')
    expect(brief).toContain('## Recent user requests')
    expect(brief).toContain('- Investigate auth bug')
    expect(brief).toContain('- Draft a fix plan')
    expect(brief).not.toContain('[Attached image')
    expect(brief).not.toContain('Subagent prompt')
    expect(brief).toContain('## Latest plan\n# Fix auth')
    expect(brief).toContain('## Latest assistant summary\nImplemented token refresh in src/auth.ts')
    expect(brief).not.toContain('Subagent reply')
    expect(brief).toContain('## Files modified\n- `src/auth.ts`\n- `src/auth.test.ts`')
    expect(brief).not.toContain('failed.ts')
    expect(brief).toContain('## Open todos\n- [in progress] Add integration test\n- [ ] Run full test suite')
    expect(brief).not.toContain('Update token refresh')
    expect(brief).not.toContain('Old todo')
    expect(brief).toContain('Inspect the current worktree')
    expect(brief.length).toBeLessThanOrEqual(MAX_HANDOFF_BRIEF_CHARS)
  })

  it('keeps only the last 6 user requests and skips prior synthetic handoff briefs', () => {
    const items: ChatItem[] = [
      userMsg('h0', `${HANDOFF_BRIEF_PREFIX}Codex in /work/repo.\n\nOld brief`),
      ...Array.from({ length: 8 }, (_, index) => userMsg(`u${index + 1}`, `Request number ${index + 1}`)),
    ]

    const brief = buildHandoffBrief({
      fromProvider: 'cursor',
      toProvider: 'codex',
      cwd: '/work/repo',
      items,
    })

    expect(brief).not.toContain('Old brief')
    expect(brief).not.toContain('Request number 1')
    expect(brief).not.toContain('Request number 2')
    expect(brief).toContain('Request number 3')
    expect(brief).toContain('Request number 8')
  })

  it('strictly bounds length to MAX_HANDOFF_BRIEF_CHARS even for massive conversations', () => {
    const items: ChatItem[] = [
      ...Array.from({ length: 10 }, (_, i) => userMsg(`u${i}`, `User request ${i} ${'a'.repeat(1000)}`)),
      planItem('p1', `# Huge plan\n${'step detail '.repeat(1000)}`),
      assistantMsg('a1', `Huge reply ${'explanation '.repeat(1000)}`),
      ...Array.from({ length: 60 }, (_, i) => fileChange(`f${i}`, `/work/repo/src/deep/nested/file-${i}.ts`)),
      todoList('td1', Array.from({ length: 30 }, (_, i) => ({ content: `Todo item ${i} ${'detail '.repeat(50)}`, status: 'pending' as const }))),
    ]

    const brief = buildHandoffBrief({
      fromProvider: 'claude',
      toProvider: 'codex',
      cwd: '/work/repo',
      title: 'T'.repeat(300),
      items,
      note: 'N'.repeat(2000),
    })

    expect(brief.length).toBeLessThanOrEqual(MAX_HANDOFF_BRIEF_CHARS)
    expect(brief.startsWith(`${HANDOFF_BRIEF_PREFIX}Claude in /work/repo.`)).toBe(true)
    expect(brief).toContain('Inspect the current worktree')
  })

  it('omits empty sections cleanly for a brand-new conversation', () => {
    const brief = buildHandoffBrief({
      fromProvider: 'codex',
      toProvider: 'claude',
      cwd: '/work/empty',
      items: [],
    })

    expect(brief).toContain('You are taking over this conversation from Codex in /work/empty.')
    expect(brief).not.toContain('## Recent user requests')
    expect(brief).not.toContain('## Latest plan')
    expect(brief).not.toContain('## Files modified')
    expect(brief).not.toContain('## Open todos')
    expect(brief).toContain('Inspect the current worktree')
  })

  it('strips unsupported control characters so the prompt is shell-safe', () => {
    const brief = buildHandoffBrief({
      fromProvider: 'claude',
      toProvider: 'cursor',
      cwd: '/work/repo',
      items: [userMsg('u1', 'Fix\u0000null\u0007bell\u001bescape')],
      note: 'Note\u0001here',
    })

    expect(brief).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u)
    expect(brief).toContain('Fix null bell escape')
    expect(brief).toContain('Note here')
  })
})

describe('handoffPermissionMode', () => {
  it('never escalates restricted chats to bypassPermissions when handing off to Cursor or Codex', () => {
    // Claude default (ask before edits, rank 1) -> Cursor/Codex drop to plan (rank 0) rather than sandboxed/workspace (rank 2) or full access (rank 3).
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'default' }), 'cursor-chat')).toBe('plan')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'default' }), 'codex-chat')).toBe('plan')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'default' }), 'deepseek-chat')).toBe('default')

    // Claude acceptEdits (rank 2) -> Cursor Sandboxed ('default', rank 2), Codex Workspace access ('default', rank 2), Muse Ask when needed ('default', rank 2).
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'acceptEdits' }), 'cursor-chat')).toBe('default')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'acceptEdits' }), 'codex-chat')).toBe('default')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'acceptEdits' }), 'muse-chat')).toBe('default')

    // Claude plan (rank 0) -> stays plan; Muse has no plan mode so supportsHandoffPermissionMode is false.
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'plan' }), 'cursor-chat')).toBe('plan')
    const museFromPlan = handoffPermissionMode(session({ provider: 'claude', permissionMode: 'plan' }), 'muse-chat')
    expect(museFromPlan).toBe('plan')
    expect(supportsHandoffPermissionMode('muse-chat', museFromPlan)).toBe(false)
  })

  it('preserves full access only when the source chat already has bypass/full access', () => {
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'bypassPermissions' }), 'cursor-chat')).toBe('bypassPermissions')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'bypassPermissions' }), 'codex-chat')).toBe('bypassPermissions')
    expect(handoffPermissionMode(session({ provider: 'claude', permissionMode: 'bypassPermissions' }), 'muse-chat')).toBe('bypassPermissions')

    // Cursor Full access and Auto-review (sandbox off) both rank as full access.
    expect(handoffPermissionMode(session({ provider: 'cursor', permissionMode: 'bypassPermissions' }), 'claude-chat')).toBe('bypassPermissions')
    expect(handoffPermissionMode(session({ provider: 'cursor', permissionMode: 'auto' }), 'claude-chat')).toBe('bypassPermissions')
    // Cursor Sandboxed maps down to Claude acceptEdits, never bypass.
    expect(handoffPermissionMode(session({ provider: 'cursor', permissionMode: 'default' }), 'claude-chat')).toBe('acceptEdits')
  })

  it('respects Muse sandboxed vs yolo full access boundaries', () => {
    expect(handoffPermissionMode(session({ provider: 'muse', permissionMode: 'acceptEdits', sandboxed: true }), 'claude-chat')).toBe('acceptEdits')
    expect(handoffPermissionMode(session({ provider: 'muse', permissionMode: 'bypassPermissions', sandboxed: true }), 'cursor-chat')).toBe('default')
    expect(handoffPermissionMode(session({ provider: 'muse', permissionMode: 'bypassPermissions', sandboxed: false }), 'cursor-chat')).toBe('bypassPermissions')
  })
})

describe('handoff divider helpers', () => {
  it('formats, detects, and parses handoff notices cleanly', () => {
    const text = handoffDividerText('claude', 'cursor')
    expect(text).toBe(`${HANDOFF_MARKER_PREFIX}Claude to Cursor`)
    expect(isHandoffNotice(text)).toBe(true)
    expect(parseHandoffNotice(text)).toEqual({ fromLabel: 'Claude', toLabel: 'Cursor' })
    expect(handoffDividerLabel(text)).toBe('Handed off from Claude → Cursor')

    expect(parseHandoffNotice('Handed off from Codex → DeepSeek')).toEqual({ fromLabel: 'Codex', toLabel: 'DeepSeek' })
    expect(isHandoffNotice('Interrupted')).toBe(false)
    expect(parseHandoffNotice('Interrupted')).toBeNull()
  })
})

describe('availableProviderModels', () => {
  it('prefers live session models over cached catalogs and falls back to catalog entries', () => {
    const catalogs: ModelCatalogs = {
      'claude:/home/.claudep': { models: [{ value: 'opus', displayName: 'Opus' }], updatedAt: 20 },
      cursor: { models: [{ value: 'claude-4-sonnet', displayName: 'Claude 4 Sonnet' }], updatedAt: 10 },
      codex: { models: [{ value: 'gpt-5.4', displayName: 'GPT-5.4' }], updatedAt: 10 },
    }
    const liveCursor = [{ value: 'auto', displayName: 'Auto' }]
    const resolved = availableProviderModels(catalogs, [{ provider: 'cursor', models: liveCursor }])
    expect(resolved.claude).toEqual([{ value: 'opus', displayName: 'Opus' }])
    expect(resolved.cursor).toEqual(liveCursor)
    expect(resolved.codex).toEqual([{ value: 'gpt-5.4', displayName: 'GPT-5.4' }])
    expect(resolved.muse).toBeUndefined()
  })
})
