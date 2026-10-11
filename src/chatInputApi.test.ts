import { describe, expect, it, vi } from 'vitest'
import { openPullRequestsForPane, uploadChatImage } from './chatInputApi'

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
})
