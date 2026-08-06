import type { WebPaneEngine, WebPanePlacement } from '../shared/protocol'

export interface WebPanesApiClient {
  open(
    url: string,
    anchor: string,
    placement?: WebPanePlacement,
    engine?: WebPaneEngine,
  ): Promise<{ webPaneId: string; status: 'open' | 'pending' }>
  confirm(webPaneId: string, allowOrigin: boolean): Promise<void>
  close(webPaneId: string): Promise<void>
  cdp(webPaneId: string): Promise<{ target: string; devtoolsFrontendUrl: string }>
  move(webPaneId: string, anchor: string, placement: 'right' | 'below'): Promise<void>
}

type ApiErrorBody = { error?: unknown }

function apiError(status: number, body: unknown): Error {
  const message =
    typeof body === 'object' && body !== null && typeof (body as ApiErrorBody).error === 'string'
      ? (body as { error: string }).error
      : `Web pane request failed (${status})`
  return new Error(message)
}

export function createWebPanesApi(
  token: string,
  fetcher: typeof fetch = fetch,
): WebPanesApiClient {
  const request = async (path: string, init: RequestInit): Promise<unknown> => {
    const response = await fetcher(`/api/web-panes${path}`, {
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
    return body
  }

  return {
    open: async (url, anchor, placement, engine) => {
      const body = await request('', {
        method: 'POST',
        body: JSON.stringify({
          url,
          anchor,
          ...(placement ? { placement } : {}),
          ...(engine ? { engine } : {}),
        }),
      }) as { webPaneId: string; status: 'open' | 'pending' }
      return body
    },
    confirm: async (webPaneId, allowOrigin) => {
      await request(`/${encodeURIComponent(webPaneId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ allowOrigin }),
      })
    },
    close: async (webPaneId) => {
      await request(`/${encodeURIComponent(webPaneId)}`, { method: 'DELETE' })
    },
    cdp: async (webPaneId) => {
      return await request(`/${encodeURIComponent(webPaneId)}/cdp`, { method: 'GET' }) as {
        target: string
        devtoolsFrontendUrl: string
      }
    },
    move: async (webPaneId, anchor, placement) => {
      await request(`/${encodeURIComponent(webPaneId)}/move`, {
        method: 'POST',
        body: JSON.stringify({ anchor, placement }),
      })
    },
  }
}
