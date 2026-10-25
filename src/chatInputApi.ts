import { isChatImageId, isChatVideoId, type ChatImageRef } from '../shared/agent-chat'
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

/** Uploads a composer video as it is, streamed from disk; the daemon checks its type. */
export async function uploadChatVideo(token: string, file: File, fetcher: typeof fetch = fetch): Promise<ChatImageRef> {
  const response = await fetcher('/api/chat/videos', {
    method: 'POST',
    body: file,
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const result = await response.json().catch(() => ({})) as { video?: { id?: unknown }; error?: string }
  if (!response.ok || !isChatVideoId(result.video?.id)) throw new Error(result.error ?? `Upload failed (${response.status})`)
  return { id: result.video.id, name: file.name || 'video' }
}

/** The open pull requests of the repository a chat pane works in, from Commando's PR tracking. */
export async function openPullRequestsForPane(prs: Pick<PrsApiClient, 'repoForPane' | 'list'>, paneId: string): Promise<PullRequestOption[]> {
  const repo = await prs.repoForPane(paneId)
  // Commando knows a pane's repository from its branch's upstream remote.
  if (!repo) throw new Error("Commando can't tell this chat's GitHub repository (its branch has no upstream on GitHub)")
  const list = await prs.list(repo, 'open', { scope: 'everyone' })
  return list.pullRequests.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft, author: pr.author }))
}

async function postPlan(token: string, target: 'vault' | 'file', markdown: string, fetcher: typeof fetch): Promise<{ path: string; dir?: string }> {
  const response = await fetcher(`/api/chat/plans/${target}`, {
    method: 'POST',
    body: JSON.stringify({ markdown }),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  const result = await response.json().catch(() => ({})) as { path?: unknown; dir?: unknown; error?: string }
  if (!response.ok || typeof result.path !== 'string') throw new Error(result.error ?? `Saving the plan failed (${response.status})`)
  return { path: result.path, ...(typeof result.dir === 'string' ? { dir: result.dir } : {}) }
}

/** Files a chat's plan as a note in the default Commando vault. */
export async function saveChatPlan(token: string, markdown: string, fetcher: typeof fetch = fetch): Promise<{ path: string }> {
  return { path: (await postPlan(token, 'vault', markdown, fetcher)).path }
}

/** Saves a plan too long for a pane's opening prompt in a folder of its own, for the new chat to read. */
export async function stashChatPlan(token: string, markdown: string, fetcher: typeof fetch = fetch): Promise<{ path: string; dir: string }> {
  const saved = await postPlan(token, 'file', markdown, fetcher)
  if (!saved.dir) throw new Error("Commando didn't say where it saved the plan")
  return { path: saved.path, dir: saved.dir }
}
