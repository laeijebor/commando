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
  // Commando knows a pane's repository from its branch's upstream remote.
  if (!repo) throw new Error("Commando can't tell this chat's GitHub repository (its branch has no upstream on GitHub)")
  const list = await prs.list(repo, 'open', { scope: 'everyone' })
  return list.pullRequests.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft, author: pr.author }))
}

async function postPlan(token: string, target: 'vault' | 'file', markdown: string, fetcher: typeof fetch): Promise<{ path: string }> {
  const response = await fetcher(`/api/chat/plans/${target}`, {
    method: 'POST',
    body: JSON.stringify({ markdown }),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const result = await response.json().catch(() => ({})) as { path?: unknown; error?: string }
  if (!response.ok || typeof result.path !== 'string') throw new Error(result.error ?? `Saving the plan failed (${response.status})`)
  return { path: result.path }
}

/** Files a chat's plan as a note in the default Commando vault. */
export function saveChatPlan(token: string, markdown: string, fetcher: typeof fetch = fetch): Promise<{ path: string }> {
  return postPlan(token, 'vault', markdown, fetcher)
}

/** Saves a plan too long for a pane's opening prompt where a new chat can read it. */
export function stashChatPlan(token: string, markdown: string, fetcher: typeof fetch = fetch): Promise<{ path: string }> {
  return postPlan(token, 'file', markdown, fetcher)
}
