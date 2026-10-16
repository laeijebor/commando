import { describe, expect, it } from 'vitest'
import { chatConversationScope, isChatConversationSessionId, parseChatConversations, type ChatConversation } from './chat-conversations.js'

const conversation = (cwd: string, extra: Partial<ChatConversation> = {}): ChatConversation => ({ provider: 'claude', sessionId: 'aaaaaaaa-0001', cwd, title: 't', updatedAt: 1, ...extra })
const mainPane = { path: '/repo', repo: { root: '/repo', name: 'repo', branch: 'main', isWorktree: false } }

describe('conversation response validation', () => {
  it('accepts Cursor and OpenCode while keeping session ids shell-safe and bounded', () => {
    const cursor = conversation('/repo', { provider: 'cursor' })
    const opencode = conversation('/repo', { provider: 'opencode', sessionId: 'ses_ed3f6d576ffeGGkSAFgSk4Snvz' })
    expect(parseChatConversations({ conversations: [cursor, opencode] })).toEqual([cursor, opencode])
    for (const id of ['ses_a;whoami', 'ses_$(pwd)', 'ses_abc\n', 'ses_a bcd', 'ses_abc/def', 'ses_abc_def', `ses_${'a'.repeat(77)}`]) {
      expect(isChatConversationSessionId(id)).toBe(false)
      expect(parseChatConversations({ conversations: [{ ...opencode, sessionId: id }] })).toEqual([])
    }
  })
})

describe('chatConversationScope', () => {
  it('keeps a worktree nested in the main checkout out of the main checkout\'s own group', () => {
    expect(chatConversationScope(conversation('/repo/src', { checkoutRoot: '/repo', repoRoot: '/repo' }), mainPane)).toBe('worktree')
    expect(chatConversationScope(conversation('/repo/.claude/worktrees/x', { checkoutRoot: '/repo/.claude/worktrees/x', repoRoot: '/repo' }), mainPane)).toBe('repo')
    expect(chatConversationScope(conversation('/elsewhere', { checkoutRoot: '/elsewhere', repoRoot: '/elsewhere' }), mainPane)).toBe('other')
    // A folder git no longer knows (a removed worktree) still counts by path.
    expect(chatConversationScope(conversation('/repo/sub'), mainPane)).toBe('worktree')
  })

  it('outside a repo, counts only the pane\'s own folder as this one', () => {
    const home = { path: '/Users/me' }
    expect(chatConversationScope(conversation('/Users/me'), home)).toBe('worktree')
    expect(chatConversationScope(conversation('/Users/me/project'), home)).toBe('other')
  })
})
