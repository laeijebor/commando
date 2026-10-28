import {
  SESSION_NAMING_ROUTES,
  type SessionNamingResponse,
  type SessionNamingSettings,
  type SuggestSessionNameRequest,
  type SuggestSessionNameResponse,
} from '../shared/session-naming'

export type SessionNamingApi = {
  /** Asks the daemon to name a session from its opening prompt; aborting stops the model. */
  suggest: (request: SuggestSessionNameRequest, signal?: AbortSignal) => Promise<SuggestSessionNameResponse>
  describe: () => Promise<SessionNamingResponse>
  update: (change: Partial<SessionNamingSettings>) => Promise<SessionNamingResponse>
  retry: () => Promise<SessionNamingResponse>
}

export function createSessionNamingApi(token: string, fetcher: typeof fetch = fetch): SessionNamingApi {
  const send = async <T,>(route: string, method: string, input?: object, signal?: AbortSignal): Promise<T> => {
    const response = await fetcher(route, {
      method,
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    })
    const body = await response.json().catch(() => ({})) as T & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `Session naming request returned ${response.status}`)
    return body
  }
  return {
    suggest: async (request, signal) => {
      const result = await send<SuggestSessionNameResponse>(SESSION_NAMING_ROUTES.suggest, 'POST', request, signal)
      return { name: typeof result.name === 'string' && result.name ? result.name : null, ...(typeof result.by === 'string' ? { by: result.by } : {}) }
    },
    describe: () => send(SESSION_NAMING_ROUTES.settings, 'GET'),
    update: (change) => send(SESSION_NAMING_ROUTES.settings, 'PUT', change),
    retry: () => send(SESSION_NAMING_ROUTES.retry, 'POST', {}),
  }
}
