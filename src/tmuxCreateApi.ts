import {
  TMUX_CREATE_ROUTES,
  parseTmuxCreateResponse,
  requireSessionAgentLaunch,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type CreateTmuxWindowRequest,
  type TmuxCreatedTarget,
  type TmuxCreateResponse,
} from '../shared/tmux-create'

export type TmuxCreateApi = {
  createSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  createWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  createPane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message
      if (typeof message === 'string' && message) return message
    }
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'string' && error) return error
      if (error && typeof error === 'object' && 'message' in error) {
        const message = (error as { message: unknown }).message
        if (typeof message === 'string' && message) return message
      }
    }
  } catch {
    // Fall back to the bounded HTTP status below.
  }
  return `tmux create request returned ${response.status}`
}

export function createTmuxHttpApi(token: string, fetcher: typeof fetch = fetch): TmuxCreateApi {
  const post = async (route: string, input: object): Promise<TmuxCreateResponse> => {
    const response = await fetcher(route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    })
    if (!response.ok) throw new Error(await responseError(response))
    return parseTmuxCreateResponse(await response.json())
  }

  return {
    createSession: async (input) => requireSessionAgentLaunch(input, await post(TMUX_CREATE_ROUTES.session, input)),
    createWindow: async (input) => (await post(TMUX_CREATE_ROUTES.window, input)).created,
    createPane: async (input) => (await post(TMUX_CREATE_ROUTES.pane, input)).created,
  }
}
