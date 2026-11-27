import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../shared/agent-chat.js'
import { extractChatItemPullRequests, seedSeenPullRequestItems } from './chat-pr-tracker.js'

const commandItem = (overrides: Partial<Extract<ChatItem, { kind: 'command' }>> = {}): Extract<ChatItem, { kind: 'command' }> => ({
  id: 'cmd-1',
  turnId: 'turn-1',
  status: 'completed',
  createdAt: 1,
  updatedAt: 2,
  kind: 'command',
  toolUseId: 'tool-1',
  command: 'git push origin feat/instant-lobby',
  ...overrides,
})

const toolItem = (overrides: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): Extract<ChatItem, { kind: 'tool' }> => ({
  id: 'mcp-1',
  turnId: 'turn-1',
  status: 'completed',
  createdAt: 1,
  updatedAt: 2,
  kind: 'tool',
  toolUseId: 'tool-2',
  toolName: 'mcp',
  title: 'github · create_pull_request',
  detail: JSON.stringify({ owner: 'Save-All', repo: 'Save-All', title: 'Instant lobby' }),
  output: 'https://github.com/Save-All/Save-All/pull/32224',
  ...overrides,
})

describe('chat-pr-tracker', () => {
  it('extracts created PRs and impacts from completed command items once', () => {
    const seen = new Set<string>()
    const createdCmd = commandItem({
      id: 'cmd-create',
      command: 'gh pr create --title "Instant lobby"',
      output: 'https://github.com/Save-All/Save-All/pull/32224\n',
    })
    const pushCmd = commandItem({
      id: 'cmd-push',
      command: 'git push origin feat/live-instant-lobby',
    })

    const first = extractChatItemPullRequests([createdCmd, pushCmd], '/work/instant-lobby', seen)
    expect(first).toEqual({
      created: [{ repo: 'Save-All/Save-All', number: 32224 }],
      impacted: [{ relation: 'pushed', cwd: '/work/instant-lobby', remote: 'origin', branch: 'feat/live-instant-lobby' }],
    })

    // Re-receiving the same completed items does not re-emit events.
    expect(extractChatItemPullRequests([createdCmd, pushCmd], '/work/instant-lobby', seen)).toEqual({
      created: [],
      impacted: [],
    })
  })

  it('ignores running, failed, errored, and seeded historical items', () => {
    const seen = new Set<string>()
    const historical = commandItem({ id: 'hist-1', command: 'git push origin old-branch' })
    seedSeenPullRequestItems([historical], seen)

    const running = commandItem({ id: 'run-1', status: 'running', command: 'git push origin feat' })
    const failed = commandItem({ id: 'fail-1', status: 'failed', command: 'git push origin feat' })
    const errored = commandItem({ id: 'err-1', isError: true, command: 'git push origin feat' })

    expect(extractChatItemPullRequests([historical, running, failed, errored], '/work', seen)).toEqual({
      created: [],
      impacted: [],
    })

    // Once the previously running command finishes cleanly, it is captured.
    expect(extractChatItemPullRequests([{ ...running, status: 'completed' }], '/work', seen)).toEqual({
      created: [],
      impacted: [{ relation: 'pushed', cwd: '/work', remote: 'origin', branch: 'feat' }],
    })
  })

  it('extracts created and impacted PRs from Cursor and Claude MCP tool items', () => {
    const seen = new Set<string>()
    const cursorCreate = toolItem()
    const cursorReview = toolItem({
      id: 'mcp-2',
      title: 'github · create_pull_request_review',
      detail: JSON.stringify({ owner: 'acme', repo: 'widgets', pullNumber: 99 }),
      output: '{}',
    })
    const claudeComment = toolItem({
      id: 'mcp-3',
      toolName: 'mcp__github__add_issue_comment',
      title: 'add_issue_comment',
      detail: JSON.stringify({ owner: 'acme', repo: 'widgets', issue_number: 12 }),
      output: '{}',
    })

    expect(extractChatItemPullRequests([cursorCreate, cursorReview, claudeComment], '/work', seen)).toEqual({
      created: [{ repo: 'Save-All/Save-All', number: 32224 }],
      impacted: [
        { relation: 'reviewed', repo: 'acme/widgets', number: 99 },
        { relation: 'commented', repo: 'acme/widgets', number: 12 },
      ],
    })
  })
})
