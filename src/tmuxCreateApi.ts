import {
  TMUX_CREATE_ROUTES,
  parseSessionCreation,
  parseTmuxCreateResponse,
  requireSessionAgentLaunch,
  type CreateTmuxPaneRequest,
  type CreateTmuxSessionRequest,
  type ClaudeProfile,
  type CreateTmuxWindowRequest,
  type LaunchTmuxPaneRequest,
  type ModelCatalogs,
  type SessionCreation,
  type StartSessionCreationRequest,
  type TmuxCreatedTarget,
  type TmuxCreateResponse,
} from '../shared/tmux-create'
import { parseChatModelOptions } from '../shared/agent-chat'

export type TmuxCreateApi = {
  createSession: (input: CreateTmuxSessionRequest) => Promise<TmuxCreateResponse>
  /**
   * Creates a session, answering once it is done or once its slow part (a worktree checkout) has
   * started, after which it finishes in the background and is followed over the websocket.
   */
  startSession: (input: StartSessionCreationRequest) => Promise<SessionCreation>
  retrySessionCreation: (id: string) => Promise<SessionCreation>
  dismissSessionCreation: (id: string) => Promise<void>
  createWindow: (input: CreateTmuxWindowRequest) => Promise<TmuxCreatedTarget>
  createPane: (input: CreateTmuxPaneRequest) => Promise<TmuxCreatedTarget>
  /** Starts a shell, or `agent`, in a pane that a session started empty. */
  launchInEmptyPane: (input: LaunchTmuxPaneRequest) => Promise<void>
  /** Claude config dirs (profiles) that chat panes can use. */
  claudeProfiles: () => Promise<ClaudeProfile[]>
  /** Each provider's model list, remembered by the daemon from earlier chats. */
  models: () => Promise<ModelCatalogs>
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
    if (!response.ok) throw Object.assign(new Error(await responseError(response)), { status: response.status })
    return response.json()
  }
  const post = async (route: string, input: object): Promise<TmuxCreateResponse> => parseTmuxCreateResponse(await send(route, input))

  return {
    createSession: async (input) => requireSessionAgentLaunch(input, await post(TMUX_CREATE_ROUTES.session, input)),
    startSession: async (input) => {
      try {
        return parseSessionCreation(((await send(TMUX_CREATE_ROUTES.sessionCreations, input)) as { creation?: unknown }).creation)
      } catch (error) {
        // A daemon from before background creation: create in one request, as before.
        if ((error as { status?: unknown }).status !== 404) throw error
        const { groupId, ...request } = input
        const result = parseTmuxCreateResponse(await send(TMUX_CREATE_ROUTES.session, request))
        return { id: `sync-${result.created.sessionId}`, name: request.name, cwd: request.cwd ?? '', ...(groupId ? { groupId } : {}), stage: 'done', startedAt: Date.now(), result }
      }
    },
    retrySessionCreation: async (id) => parseSessionCreation(((await send(`${TMUX_CREATE_ROUTES.sessionCreations}/${encodeURIComponent(id)}/retry`, {})) as { creation?: unknown }).creation),
    dismissSessionCreation: async (id) => {
      const response = await fetcher(`${TMUX_CREATE_ROUTES.sessionCreations}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok && response.status !== 404) throw new Error(await responseError(response))
    },
    createWindow: async (input) => (await post(TMUX_CREATE_ROUTES.window, input)).created,
    createPane: async (input) => (await post(TMUX_CREATE_ROUTES.pane, input)).created,
    launchInEmptyPane: async (input) => { await send(TMUX_CREATE_ROUTES.launch, input) },
    models: async () => {
      const response = await fetcher(TMUX_CREATE_ROUTES.models, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = await response.json() as { catalogs?: unknown }
      const catalogs = body.catalogs && typeof body.catalogs === 'object' && !Array.isArray(body.catalogs) ? body.catalogs as Record<string, unknown> : {}
      return Object.fromEntries(Object.entries(catalogs).flatMap(([key, entry]) => {
        const { models, updatedAt } = (entry ?? {}) as { models?: unknown; updatedAt?: unknown }
        const parsed = parseChatModelOptions(models)
        return parsed?.length && typeof updatedAt === 'number' ? [[key, { models: parsed, updatedAt }]] : []
      }))
    },
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
