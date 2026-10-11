import { describe, expect, it, vi } from 'vitest'
import { openPullRequestsForPane, saveChatPlan, stashChatPlan, uploadChatImage } from './chatInputApi'

const id = `${'b'.repeat(64)}.jpg`

describe('chat input API', () => {
  it('uploads the image bytes with the token and returns its ref', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ image: { id } }), { status: 201 }))
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    expect(await uploadChatImage('tok', { blob, name: 'photo.jpg', type: 'image/jpeg' }, fetcher as unknown as typeof fetch)).toEqual({ id, name: 'photo.jpg' })
    expect(fetcher).toHaveBeenCalledWith('/api/chat/images', expect.objectContaining({ method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer tok' } }))
  })

  it('reports the daemon’s refusal', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Images must be 10 MB or smaller' }), { status: 413 }))
    await expect(uploadChatImage('', { blob: new Blob(['x']), name: 'x.png', type: 'image/png' }, fetcher as unknown as typeof fetch)).rejects.toThrow('Images must be 10 MB or smaller')
  })

  it('lists the open PRs of the pane’s repository from Commando’s PR tracking', async () => {
    const prs = {
      repoForPane: vi.fn(async () => 'laeijebor/commando'),
      list: vi.fn(async () => ({ pullRequests: [{ number: 32, title: 'Controls', url: 'u', isDraft: false, author: 'leo' }] })),
    }
    expect(await openPullRequestsForPane(prs as never, '%3')).toEqual([{ number: 32, title: 'Controls', url: 'u', isDraft: false, author: 'leo' }])
    expect(prs.list).toHaveBeenCalledWith('laeijebor/commando', 'open', { scope: 'everyone' })
    await expect(openPullRequestsForPane({ repoForPane: async () => null, list: vi.fn() } as never, '%3')).rejects.toThrow("can't tell this chat's GitHub repository")
  })

  it('saves a plan to the vault or stashes it for a new pane, and reports refusals', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ path: '/v/Plans/p.md', title: 'P' }), { status: 201 }))
    expect(await saveChatPlan('tok', '# P', fetcher as unknown as typeof fetch)).toEqual({ path: '/v/Plans/p.md' })
    expect(fetcher).toHaveBeenCalledWith('/api/chat/plans/vault', expect.objectContaining({ method: 'POST', body: JSON.stringify({ markdown: '# P' }), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' } }))
    // A stash names its own folder, the one the new chat is given.
    await expect(stashChatPlan('tok', '# P', fetcher as unknown as typeof fetch)).rejects.toThrow("didn't say where")
    const stashing = vi.fn(async () => new Response(JSON.stringify({ path: '/p/abc/plan.md', dir: '/p/abc' }), { status: 201 }))
    expect(await stashChatPlan('tok', '# P', stashing as unknown as typeof fetch)).toEqual({ path: '/p/abc/plan.md', dir: '/p/abc' })
    expect(stashing).toHaveBeenLastCalledWith('/api/chat/plans/file', expect.anything())
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: 'The plan is too long' }), { status: 413 }))
    await expect(saveChatPlan('', 'x', refusing as unknown as typeof fetch)).rejects.toThrow('The plan is too long')
  })
})
