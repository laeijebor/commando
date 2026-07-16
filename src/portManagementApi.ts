import type { OpenPort } from '../shared/protocol'

export interface PortManagementApiClient {
  killPort(port: OpenPort): Promise<void>
  killSessionPorts(sessionId: string): Promise<void>
}

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Port management request failed (${status})`
  return new Error(message)
}

export function createPortManagementApi(
  token: string,
  fetcher: typeof fetch = fetch,
): PortManagementApiClient {
  const request = async (path: string, body: unknown): Promise<void> => {
    const response = await fetcher(`/api/port-management${path}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    const result = await response.json().catch(() => null) as unknown
    if (!response.ok) throw apiError(response.status, result)
  }

  return {
    killPort: (port) => request('/ports/kill', {
      sessionId: port.sessionId,
      paneId: port.paneId,
      port: port.port,
      confirmPort: port.port,
    }),
    killSessionPorts: (sessionId) => request(`/sessions/${encodeURIComponent(sessionId)}/kill`, {
      confirmSessionId: sessionId,
    }),
  }
}
