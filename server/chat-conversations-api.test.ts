import { mkdtemp, rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSessionInfo } from '../shared/agent-chat.js'
import type { ChatConversation } from '../shared/chat-conversations.js'
import type { CommandoSnapshot } from '../shared/protocol.js'
import { ChatConversationsApi } from './chat-conversations-api.js'

const ID = '11111111-2222-3333-4444-555555555555'
let folder: string
beforeEach(async () => { folder = await mkdtemp(join(tmpdir(), 'commando-resume-')) })
afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

function request(method: string, path: string, value?: unknown): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage & PassThrough
  Object.assign(stream, { method, url: path, headers: { 'content-type': 'application/json' } })
  stream.end(value === undefined ? undefined : JSON.stringify(value))
  return stream
}

function response() {
  const result = { status: 0, body: undefined as unknown, headers: {} as Record<string, unknown> }
  const fake = {
    setHeader: (name: string, value: unknown) => { result.headers[name] = value },
    writeHead: (status: number) => { result.status = status },
    end: (body: string) => { result.body = JSON.parse(body) },
  } as unknown as ServerResponse
  return { fake, result }
}

const chat = (overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({ paneId: '%1', provider: 'claude', cwd: '/x', status: 'idle', hostPid: 1, hostVersion: 5, permissionMode: 'acceptEdits', sessionId: 'aaaaaaaa-0000', ...overrides })

function setup(options: { conversation?: Partial<ChatConversation>; chats?: ChatSessionInfo[] } = {}) {
  const conversation: ChatConversation = { provider: 'codex', sessionId: ID, cwd: folder, title: 'Old', updatedAt: 1, ...options.conversation }
  const chats = options.chats ?? [chat()]
  const creator = {
    respawnChatPane: vi.fn(async () => {}),
    createPane: vi.fn(async () => ({ paneId: '%9' }) as never),
  }
  const api = new ChatConversationsApi({
    index: { list: vi.fn(async () => [conversation]), find: vi.fn(async (provider, sessionId) => provider === conversation.provider && sessionId === conversation.sessionId ? conversation : undefined) },
    snapshot: () => ({ panes: [{ id: '%1' }, { id: '%2' }] }) as unknown as CommandoSnapshot,
    chatSession: (paneId) => chats.find((session) => session.paneId === paneId),
    chatSessions: () => chats,
    creator,
    beforePaneCreated: vi.fn(async () => {}),
    refreshSnapshot: vi.fn(async () => {}),
  })
  const resume = async (input: Record<string, unknown>) => {
    const { fake, result } = response()
    await api.handle(request('POST', '/api/chat-conversations/resume', { paneId: '%1', provider: 'codex', sessionId: ID, placement: 'replace', ...input }), fake, new URL('http://x/api/chat-conversations/resume'))
    return result
  }
  return { api, creator, resume, conversation }
}

describe('ChatConversationsApi', () => {
  it('lists conversations', async () => {
    const { api, conversation } = setup()
    const { fake, result } = response()
    expect(await api.handle(request('GET', '/api/chat-conversations'), fake, new URL('http://x/api/chat-conversations'))).toBe(true)
    expect(result).toMatchObject({ status: 200, body: { conversations: [conversation] } })
  })

  it('switches the chat pane to the conversation in its own folder, never above the chat\'s permissions', async () => {
    const { creator, resume } = setup()
    expect(await resume({})).toMatchObject({ status: 200, body: { paneId: '%1' } })
    // Claude's acceptEdits ranks with Codex's default (workspace access).
    expect(creator.respawnChatPane).toHaveBeenCalledWith('%1', folder, { provider: 'codex-chat', permissionMode: 'default', resume: ID })
  })

  it('opens a Claude conversation beside the pane with its own profile, in plan mode from a plan chat', async () => {
    const { creator, resume } = setup({ conversation: { provider: 'claude', configDir: '/home/me/.claudew' }, chats: [chat({ provider: 'codex', permissionMode: 'plan' })] })
    expect(await resume({ provider: 'claude', placement: 'split' })).toMatchObject({ status: 200, body: { paneId: '%9' } })
    expect(creator.createPane).toHaveBeenCalledWith({ targetId: '%1', direction: 'horizontal', placement: 'after', cwd: folder, agent: { provider: 'claude-chat', permissionMode: 'plan', resume: ID, configDir: '/home/me/.claudew' } })
  })

  it('lets only one pane resume a conversation, until its new host has had time to report it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const { creator, resume } = setup({ chats: [chat(), chat({ paneId: '%2', sessionId: 'bbbbbbbb-0000' })] })
      const [first, second] = await Promise.all([resume({}), resume({ paneId: '%2' })])
      expect([first.status, second.status].sort()).toEqual([200, 409])
      expect(await resume({ paneId: '%2' })).toMatchObject({ status: 409, body: { error: 'That conversation is already being opened' } })
      vi.advanceTimersByTime(15_000)
      expect(await resume({ paneId: '%2' })).toMatchObject({ status: 200 })
      expect(creator.respawnChatPane).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses unknown conversations, non-chat panes, open conversations and missing folders', async () => {
    expect(await setup().resume({ sessionId: '22222222-0000' })).toMatchObject({ status: 404 })
    expect(await setup().resume({ paneId: '%2' })).toMatchObject({ status: 409, body: { error: expect.stringContaining('from a chat pane') } })
    const open = setup({ chats: [chat(), chat({ paneId: '%2', provider: 'codex', sessionId: ID })] })
    expect(await open.resume({})).toMatchObject({ status: 409, body: { error: 'That conversation is already open in pane %2' } })
    const gone = setup({ conversation: { cwd: join(folder, 'deleted') } })
    expect(await gone.resume({})).toMatchObject({ status: 409, body: { error: expect.stringContaining('no longer exists') } })
    expect(await setup().resume({ placement: 'elsewhere' })).toMatchObject({ status: 400 })
    expect(open.creator.respawnChatPane).not.toHaveBeenCalled()
  })
})
