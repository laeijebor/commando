import {
  TMUX_CREATE_ROUTES,
  parseTmuxCreateResponse,
  requireSessionAgentLaunch,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type ClaudeProfile,
  type CreateTmuxWindowRequest,
  type LaunchTmuxPaneRequest,
  type TmuxCreatedTarget,
  type TmuxCreateResponse,
} from '../shared/tmux-create'

export type TmuxCreateApi = {
  createSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  createWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  createPane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
  /** Starts a shell, or `agent`, in a pane that a session started empty. */
  launchInEmptyPane: (input: LaunchTmuxPaneRequest) => Promise<void>
  /** Claude config dirs (profiles) that chat panes can use. */
  claudeProfiles: () => Promise<ClaudeProfile[]>
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
  const send = async (route: string, input: object): Promise<unknown> => {
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
    return response.json()
  }
  const post = async (route: string, input: object): Promise<TmuxCreateResponse> => parseTmuxCreateResponse(await send(route, input))

  return {
    createSession: async (input) => requireSessionAgentLaunch(input, await post(TMUX_CREATE_ROUTES.session, input)),
    createWindow: async (input) => (await post(TMUX_CREATE_ROUTES.window, input)).created,
    createPane: async (input) => (await post(TMUX_CREATE_ROUTES.pane, input)).created,
    launchInEmptyPane: async (input) => { await send(TMUX_CREATE_ROUTES.launch, input) },
    claudeProfiles: async () => {
      const response = await fetcher(TMUX_CREATE_ROUTES.claudeProfiles, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { profiles?: unknown }
      return Array.isArray(body.profiles)
        ? body.profiles.filter((profile): profile is ClaudeProfile => Boolean(profile) && typeof profile.name === 'string' && typeof profile.configDir === 'string'
          && (profile.lastUsedAt === undefined || typeof profile.lastUsedAt === 'number')
          && (profile.label === undefined || typeof profile.label === 'string') && (profile.isDefault === undefined || typeof profile.isDefault === 'boolean'))
        : []
    },
  }
}
