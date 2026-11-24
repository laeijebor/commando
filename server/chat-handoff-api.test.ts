import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatItem, ChatSessionInfo } from '../shared/agent-chat.js'
import type { ChatPlanStore } from './chat-plans.js'
import { ChatHandoffApi } from './chat-handoff-api.js'
import type { TmuxCreator } from './tmux-create.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function session(overrides: Partial<ChatSessionInfo> = {}): ChatSessionInfo {
  return {
    paneId: '%5',
    provider: 'claude',
    cwd: '/work/repo',
    status: 'idle',
    hostPid: 100,
    hostVersion: 8,
    permissionMode: 'acceptEdits',
    title: 'Fix auth bug',
    ...overrides,
  }
}

function item(id: string, kind: 'user_message' | 'assistant_message', text: string): ChatItem {
  return {
    id,
    turnId: `t-${id}`,
    status: 'completed',
    createdAt: 1,
    updatedAt: 1,
    kind,
    text,
  }
}

async function setup(options: {
  sessions?: Record<string, ChatSessionInfo>
  items?: Record<string, ChatItem[]>
  respawnChatPane?: Mock<TmuxCreator['respawnChatPane']>
  stash?: Mock<ChatPlanStore['stash']>
  maxPanePromptBytes?: number
} = {}) {
  const sessions = options.sessions ?? { '%5': session() }
  const items = options.items ?? {
    '%5': [
      item('u1', 'user_message', 'Fix the login timeout'),
      item('a1', 'assistant_message', 'Updated the timeout helper and verified tests.'),
    ],
  }
  const creator = {
    respawnChatPane: options.respawnChatPane ?? vi.fn<TmuxCreator['respawnChatPane']>(async () => {}),
  }
  const plans = {
    stash: options.stash ?? vi.fn<ChatPlanStore['stash']>(async () => ({ path: '/tmp/plans/abc123/plan.md', dir: '/tmp/plans/abc123' })),
  }
  const prepareHandoff = vi.fn()
  const announceHandoff = vi.fn()
  const cancelHandoff = vi.fn()
  const refreshSnapshot = vi.fn(async () => {})

  const api = new ChatHandoffApi({
    chatSession: (paneId) => sessions[paneId],
    chatItems: (paneId) => items[paneId] ?? [],
    creator,
    plans,
    prepareHandoff,
    announceHandoff,
    cancelHandoff,
    refreshSnapshot,
    ...(options.maxPanePromptBytes !== undefined ? { maxPanePromptBytes: options.maxPanePromptBytes } : {}),
  })

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    void api.handle(request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(404)
        response.end()
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const post = (paneId: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/chat/${encodeURIComponent(paneId)}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  return { base, post, creator, plans, prepareHandoff, announceHandoff, cancelHandoff, refreshSnapshot }
}

describe('ChatHandoffApi', () => {
  it('hands off an idle chat to another provider in the same cwd with mapped permissions and brief', async () => {
    const { post, creator, plans, prepareHandoff, announceHandoff, cancelHandoff, refreshSnapshot } = await setup()
    const response = await post('%5', { targetProvider: 'cursor', model: 'claude-4-sonnet', note: 'Double-check error paths.' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      paneId: '%5',
      fromProvider: 'claude',
      toProvider: 'cursor',
      permissionMode: 'default',
      model: 'claude-4-sonnet',
      stashed: false,
    })

    expect(plans.stash).not.toHaveBeenCalled()
    expect(prepareHandoff).toHaveBeenCalledWith('%5', 'claude', 'cursor')
    expect(creator.respawnChatPane).toHaveBeenCalledTimes(1)
    expect(creator.respawnChatPane).toHaveBeenCalledWith(
      '%5',
      '/work/repo',
      expect.objectContaining({
        provider: 'cursor-chat',
        permissionMode: 'default',
        model: 'claude-4-sonnet',
        prompt: expect.stringContaining('You are taking over this conversation from Claude in /work/repo.'),
      }),
    )
    const launch = creator.respawnChatPane.mock.calls[0]![2] as { prompt: string }
    expect(launch.prompt).toContain('Double-check error paths.')
    expect(launch.prompt).toContain('Fix the login timeout')
    expect(announceHandoff).toHaveBeenCalledWith('%5')
    expect(cancelHandoff).not.toHaveBeenCalled()
    expect(refreshSnapshot).toHaveBeenCalledTimes(1)
  })

  it('stashes briefs exceeding MAX_PANE_PROMPT_BYTES and sets readableDir only for claude and cursor', async () => {
    const cursorCtx = await setup({ maxPanePromptBytes: 50 })
    const cursorRes = await cursorCtx.post('%5', { targetProvider: 'cursor' })
    expect(cursorRes.status).toBe(200)
    expect(await cursorRes.json()).toMatchObject({ ok: true, stashed: true })
    expect(cursorCtx.plans.stash).toHaveBeenCalledTimes(1)
    expect(cursorCtx.creator.respawnChatPane).toHaveBeenCalledWith(
      '%5',
      '/work/repo',
      expect.objectContaining({
        provider: 'cursor-chat',
        readableDir: '/tmp/plans/abc123',
        prompt: expect.stringContaining('/tmp/plans/abc123/plan.md'),
      }),
    )

    const codexCtx = await setup({ maxPanePromptBytes: 50 })
    const codexRes = await codexCtx.post('%5', { targetProvider: 'codex' })
    expect(codexRes.status).toBe(200)
    expect(await codexRes.json()).toMatchObject({ ok: true, stashed: true })
    const codexLaunch = codexCtx.creator.respawnChatPane.mock.calls[0]![2] as Record<string, unknown>
    expect(codexLaunch.readableDir).toBeUndefined()
    expect(codexLaunch.prompt).toContain('/tmp/plans/abc123/plan.md')
  })

  it('never escalates restricted chats and rejects handing off to Muse when no safe mode exists', async () => {
    const restricted = await setup({ sessions: { '%5': session({ provider: 'claude', permissionMode: 'default' }) } })
    const cursorRes = await restricted.post('%5', { targetProvider: 'cursor' })
    expect(cursorRes.status).toBe(200)
    expect(restricted.creator.respawnChatPane).toHaveBeenCalledWith(
      '%5',
      '/work/repo',
      expect.objectContaining({ provider: 'cursor-chat', permissionMode: 'plan' }),
    )

    const museRes = await restricted.post('%5', { targetProvider: 'muse' })
    expect(museRes.status).toBe(403)
    expect(await museRes.json()).toEqual({ error: 'Muse has no permission mode as restricted as this chat' })
  })

  it('sets fullAccess for muse-chat when handing off from a bypassPermissions session', async () => {
    const bypass = await setup({ sessions: { '%5': session({ provider: 'claude', permissionMode: 'bypassPermissions' }) } })
    const res = await bypass.post('%5', { targetProvider: 'muse' })
    expect(res.status).toBe(200)
    expect(bypass.creator.respawnChatPane).toHaveBeenCalledWith(
      '%5',
      '/work/repo',
      expect.objectContaining({ provider: 'muse-chat', permissionMode: 'bypassPermissions', fullAccess: true }),
    )
  })

  it('rejects mid-turn handoffs with 409', async () => {
    for (const status of ['running', 'starting', 'waiting'] as const) {
      const ctx = await setup({ sessions: { '%5': session({ status }) } })
      const res = await ctx.post('%5', { targetProvider: 'cursor' })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Wait for the current turn to finish before handing off' })
      expect(ctx.creator.respawnChatPane).not.toHaveBeenCalled()
    }
  })

  it('validates pane existence, targetProvider, model, and HTTP method', async () => {
    const ctx = await setup()
    expect((await fetch(`${ctx.base}/api/chat/%255/handoff`, { method: 'GET' })).status).toBe(405)
    expect((await ctx.post('not-a-pane', { targetProvider: 'cursor' })).status).toBe(400)
    expect((await ctx.post('%99', { targetProvider: 'cursor' })).status).toBe(404)
    expect((await ctx.post('%5', { targetProvider: 'unknown' })).status).toBe(400)
    expect((await ctx.post('%5', { targetProvider: 'claude' })).status).toBe(400)
    expect((await ctx.post('%5', { targetProvider: 'cursor', model: 'bad model id!' })).status).toBe(400)
  })

  it('cancels prepared timeline carry-over if respawning the pane fails', async () => {
    const respawnChatPane = vi.fn<TmuxCreator['respawnChatPane']>(async () => { throw new Error('tmux respawn failed') })
    const ctx = await setup({ respawnChatPane })
    const res = await ctx.post('%5', { targetProvider: 'cursor' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'tmux respawn failed' })
    expect(ctx.prepareHandoff).toHaveBeenCalledWith('%5', 'claude', 'cursor')
    expect(ctx.cancelHandoff).toHaveBeenCalledWith('%5')
    expect(ctx.announceHandoff).not.toHaveBeenCalled()
  })

  it('omits default model alias from launch so the target provider picks its own default', async () => {
    const ctx = await setup()
    const res = await ctx.post('%5', { targetProvider: 'codex', model: 'default' })
    expect(res.status).toBe(200)
    const launch = ctx.creator.respawnChatPane.mock.calls[0]![2] as Record<string, unknown>
    expect(launch.model).toBeUndefined()
  })
})
