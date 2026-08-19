import type { PaneMarkTone } from '../shared/protocol'

export interface PaneManagementApiClient {
  renamePane(paneId: string, title: string): Promise<void>
  deletePane(paneId: string): Promise<void>
  openPanePath(paneId: string): Promise<void>
  runInPanePath(paneId: string, command: string): Promise<void>
  setPaneMark(paneId: string, targetId: string, label: string, tone: PaneMarkTone): Promise<void>
  acknowledgePaneMark(paneId: string, targetId: string): Promise<void>
  clearPaneMark(paneId: string, targetId: string): Promise<void>
}

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Pane management request failed (${status})`
  return new Error(message)
}

export function createPaneManagementApi(
  token: string,
  fetcher: typeof fetch = fetch,
): PaneManagementApiClient {
  const request = async (path: string, init: RequestInit): Promise<void> => {
    const response = await fetcher(`/api/pane-management${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, body)
  }

  return {
    renamePane: (paneId, title) => request(`/panes/${encodeURIComponent(paneId)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
    deletePane: (paneId) => request(`/panes/${encodeURIComponent(paneId)}/delete`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmPaneId: paneId }),
    }),
    openPanePath: (paneId) => request(`/panes/${encodeURIComponent(paneId)}/open`, {
      method: 'POST',
    }),
    runInPanePath: (paneId, command) => request(`/panes/${encodeURIComponent(paneId)}/run`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),
    setPaneMark: (paneId, targetId, label, tone) => request(`/panes/${encodeURIComponent(paneId)}/mark`, {
      method: 'POST',
      body: JSON.stringify({ targetId, label, tone }),
    }),
    acknowledgePaneMark: (paneId, targetId) => request(`/panes/${encodeURIComponent(paneId)}/mark/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
    clearPaneMark: (paneId, targetId) => request(`/panes/${encodeURIComponent(paneId)}/mark`, {
      method: 'DELETE',
      body: JSON.stringify({ targetId }),
    }),
  }
}
