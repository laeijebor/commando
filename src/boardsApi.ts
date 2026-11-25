import type { BoardItem, BoardPlacement, BoardView } from '../shared/board'
import { createChannel } from './webPanesApi'

export type BoardChange = { targetId: string; rev: number; host: string }
const changes = createChannel<BoardChange>()
export const publishBoardChange = changes.publish
export const subscribeBoardChanges = changes.subscribe
const refresh = createChannel<string>()
export const publishBoardRefresh = refresh.publish
export const subscribeBoardRefresh = refresh.subscribe

export function boardThumbPath(hash: string, size: 320 | 960): string {
  return `/api/boards/thumbs/${encodeURIComponent(hash)}/${size}`
}

export type BoardsApiClient = ReturnType<typeof createBoardsApi>

/** Pass HostContext.daemonFetch so both reads and mutations belong to the owning host. */
export function createBoardsApi(token: string, fetcher: typeof fetch = fetch) {
  const request = async <T>(targetId: string, suffix = '', method = 'GET', value?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetcher(`/api/boards/${encodeURIComponent(targetId)}${suffix}`, {
      method, credentials: 'same-origin', signal,
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    })
    if (response.status === 204) return undefined as T
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(body?.error ?? `Board request failed (${response.status})`)
    return body as T
  }
  const itemPath = (key: string) => `/items/${encodeURIComponent(key)}`
  return {
    get: async (targetId: string, signal?: AbortSignal) => {
      const board = await request<BoardView>(targetId, '', 'GET', undefined, signal)
      if (!board || !Array.isArray(board.items) || !Array.isArray(board.groups) || !Array.isArray(board.links) || !board.placements || typeof board.rev !== 'number') throw new Error('Board response unavailable. Try reconnecting to Commando.')
      return board
    },
    place: (targetId: string, key: string, placement: Partial<BoardPlacement>) => request<BoardView>(targetId, '/place', 'POST', { key, ...placement }),
    patch: (targetId: string, key: string, patch: Pick<Partial<BoardItem>, 'pinned' | 'title' | 'caption'>) => request<unknown>(targetId, itemPath(key), 'PATCH', patch),
    remove: (targetId: string, key: string) => request<void>(targetId, itemPath(key), 'DELETE'),
    revive: (targetId: string, key: string, anchorPaneId: string) => request<{ path?: string; webPaneId?: string }>(targetId, `${itemPath(key)}/revive`, 'POST', { anchorPaneId }),
    reveal: (targetId: string, key: string) => request<void>(targetId, `${itemPath(key)}/reveal`, 'POST'),
  }
}
