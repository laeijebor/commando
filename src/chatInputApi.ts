import { isChatImageId, type ChatImageRef } from '../shared/agent-chat'
import type { PreparedImage } from './chat/attachImages'
import type { PullRequestOption } from './chat/composerTriggers'
import type { PrsApiClient } from './prsApi'

/** Uploads a composer image; the chat message then names it by id. */
export async function uploadChatImage(token: string, image: PreparedImage, fetcher: typeof fetch = fetch): Promise<ChatImageRef> {
  const response = await fetcher('/api/chat/images', {
    method: 'POST',
    body: image.blob,
    credentials: 'same-origin',
    headers: { 'Content-Type': image.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const result = await response.json().catch(() => ({})) as { image?: { id?: unknown }; error?: string }
  if (!response.ok || !isChatImageId(result.image?.id)) throw new Error(result.error ?? `Upload failed (${response.status})`)
  return { id: result.image.id, name: image.name }
}

/** The open pull requests of the repository a chat pane works in, from Commando's PR tracking. */
export async function openPullRequestsForPane(prs: Pick<PrsApiClient, 'repoForPane' | 'list'>, paneId: string): Promise<PullRequestOption[]> {
  const repo = await prs.repoForPane(paneId)
  if (!repo) throw new Error("This chat's folder isn't a GitHub repository")
  const list = await prs.list(repo, 'open', { scope: 'everyone' })
  return list.pullRequests.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft, author: pr.author }))
}
