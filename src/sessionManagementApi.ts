export type SessionPreferenceGroup = {
  id: string
  name: string
  sessionIds: string[]
}

export type SessionTreePreferences = {
  version: 1
  groups: SessionPreferenceGroup[]
  ungroupedSessionIds: string[]
  sessionNamesById?: Record<string, string>
}

export interface SessionManagementApiClient {
  loadPreferences(): Promise<SessionTreePreferences>
  savePreferences(preferences: SessionTreePreferences): Promise<SessionTreePreferences>
  renameSession(sessionId: string, name: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  deleteWindow(windowId: string): Promise<void>
}

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Session management request failed (${status})`
  return new Error(message)
}

export function createSessionManagementApi(
  token: string,
  fetcher: typeof fetch = fetch,
): SessionManagementApiClient {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`/api/session-management${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    })
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // Preserve the status-based error when a proxy returns a non-JSON response.
    }
    if (!response.ok) throw apiError(response.status, body)
    return body as T
  }

  return {
    async loadPreferences() {
      const result = await request<{ preferences: SessionTreePreferences }>('/preferences')
      return result.preferences
    },
    async savePreferences(preferences) {
      const result = await request<{ preferences: SessionTreePreferences }>('/preferences', {
        method: 'PUT',
        body: JSON.stringify({ preferences }),
      })
      return result.preferences
    },
    async renameSession(sessionId, name) {
      await request(`/sessions/${encodeURIComponent(sessionId)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
    },
    async deleteSession(sessionId) {
      await request(`/sessions/${encodeURIComponent(sessionId)}/delete`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmSessionId: sessionId }),
      })
    },
    async deleteWindow(windowId) {
      await request(`/windows/${encodeURIComponent(windowId)}/delete`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmWindowId: windowId }),
      })
    },
  }
}
